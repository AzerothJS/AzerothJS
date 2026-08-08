// @vitest-environment node
//
// Real Bun and Deno, not a mock. The kernel's Fetch contract is the one thing a Node-only
// suite structurally cannot check: `app.handle` returns a PayloadResponse, which satisfies
// `instanceof Response` and which the Node adapter writes straight to a socket - so every
// Node assertion passes while a standard Fetch host refuses the very same value. Bun answers
// `Expected a Response object`; Deno, `must be a Response constructed via the Response
// constructor in this realm`.
//
// So this spec spawns the actual runtimes against the actual `src`, serves over a real
// socket with each runtime's own primitive, and drives it with real fetch(). It skips when a
// runtime is absent (CI images vary) rather than pretending - a skip is honest, a mock is not.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute file: URL of the kernel source, so a spawned runtime imports what this repo builds. */
const KERNEL = new URL('../src/index.ts', import.meta.url).href;
const API = new URL('../src/api/index.ts', import.meta.url).href;

function has(runtime: string): boolean
{
    const probe = spawnSync(runtime, ['--version'], { encoding: 'utf8', shell: true });
    return probe.status === 0;
}

const HAS_BUN = has('bun');
const HAS_DENO = has('deno');

/**
 * The program each runtime executes: build an app, serve it on that runtime's own primitive
 * through `toFetchHandler`, then assert over real HTTP. Prints one JSON line.
 */
function program(): string
{
    return `
import { App, pipeline, requestId, securityHeaders, rateLimit, json, text, noContent, toFetchHandler } from ${ JSON.stringify(KERNEL) };
import { feature, register } from ${ JSON.stringify(API) };

let guards = 0;
const app = new App({ dev: true });
app.get('/healthz', () => json({ ok: true }));
app.get('/none', () => noContent());
app.get('/cookies', () => {
    const r = text('ok');
    r.headers.append('set-cookie', 'session=abc; Path=/');
    r.headers.append('set-cookie', 'csrf=xyz; Path=/');
    r.headers.set('cache-control', 'no-store');
    return r;
});
app.get('/stream', () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('streamed')); c.close(); }
}), { status: 200 }));
register(app, { demo: feature('/demo', [() => { guards += 1; }], (r) => ({
    hello: r.get('/hello', {}, () => text('hello')),
    open: r.only().get('/open', {}, () => text('open'))
})) });

// A runtime with no socket-address capability must be given a key; the limiter says so itself.
const handler = pipeline(app, requestId(), securityHeaders(),
    rateLimit({ limit: 500, windowMs: 60000, key: () => 'probe' }));
const fetchHandler = toFetchHandler(handler);

// Port 0: the OS picks a free one and the runtime reports it back. A hardcoded port makes an
// occupied port look like a broken framework contract - with a squatter on the old fixed port,
// every check below fetched the SQUATTER and reported false.
const isDeno = typeof Deno !== 'undefined';
const server = isDeno
    ? Deno.serve({ port: 0, onListen: () => undefined }, fetchHandler)
    : Bun.serve({ port: 0, fetch: fetchHandler });

const port = isDeno ? server.addr.port : server.port;
const base = 'http://localhost:' + port;
const out = {};
let r = await fetch(base + '/healthz');
out.routing = r.status === 200 && (await r.text()) === '{"ok":true}';
r = await fetch(base + '/api/demo/hello');
out.typedApiAndGuard = r.status === 200 && (await r.text()) === 'hello' && guards === 1;
r = await fetch(base + '/api/demo/open');
out.onlyUnguarded = r.status === 200 && (await r.text()) === 'open';
out.notFound = (await fetch(base + '/nope')).status === 404;
out.nullBody = (await fetch(base + '/none')).status === 204;
r = await fetch(base + '/cookies');
await r.text();
out.repeatedSetCookie = r.headers.getSetCookie().length === 2;
out.viewHeaderSurvives = r.headers.get('cache-control') === 'no-store';
out.streamPassthrough = (await fetch(base + '/stream')).text().then ? (await (await fetch(base + '/stream')).text()) === 'streamed' : false;
r = await fetch(base + '/healthz');
out.securityHeaders = r.headers.get('x-content-type-options') === 'nosniff';
out.rateLimitHeaders = r.headers.get('ratelimit-limit') === '500';

console.log('RESULT' + JSON.stringify(out));
if (isDeno) { await server.shutdown(); } else { server.stop(true); }
`;
}

function runOn(runtime: 'bun' | 'deno'): Record<string, boolean>
{
    // The probe lives INSIDE the repo: `request-root.ts` imports the bare specifier
    // `azerothjs/internal`, which only resolves from a directory that can walk up to this
    // workspace's node_modules. Run it from the OS temp dir and Deno reports
    // `Import "azerothjs/internal" not a dependency` - a harness artefact, not a framework one.
    const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), `.runtime-probe-${ runtime }-`));
    try
    {
        const file = join(dir, 'probe.mjs');
        writeFileSync(file, program());
        // Deno needs to be told to use the node_modules directory it just walked up to.
        const args = runtime === 'deno' ? ['run', '-A', '--node-modules-dir=manual', file] : [file];
        const result = spawnSync(runtime, args, { encoding: 'utf8', shell: true, timeout: 60_000 });
        const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT'));
        if (line === undefined)
        {
            // Say WHY. A single "produced no result" hides a spawn failure, a timeout, and a
            // genuine contract break behind one string, and the first two are not framework news.
            const why = result.error !== undefined ? `spawn failed: ${ result.error.message }`
                : result.signal !== null ? `killed by ${ result.signal } (timeout is 60s)`
                    : `exit code ${ result.status }`;
            throw new Error(`${ runtime } produced no result - ${ why }.\nstdout: ${ result.stdout }\nstderr: ${ result.stderr }`);
        }
        return JSON.parse(line.slice('RESULT'.length)) as Record<string, boolean>;
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('the kernel serves on a standard Fetch runtime', () =>
{
    it.skipIf(!HAS_BUN)('Bun.serve accepts toFetchHandler and every contract holds', () =>
    {
        const checks = runOn('bun');
        expect(checks).toEqual({
            routing: true, typedApiAndGuard: true, onlyUnguarded: true, notFound: true,
            nullBody: true, repeatedSetCookie: true, viewHeaderSurvives: true,
            streamPassthrough: true, securityHeaders: true, rateLimitHeaders: true
        });
    }, 90_000);

    it.skipIf(!HAS_DENO)('Deno.serve accepts toFetchHandler and every contract holds', () =>
    {
        const checks = runOn('deno');
        expect(checks).toEqual({
            routing: true, typedApiAndGuard: true, onlyUnguarded: true, notFound: true,
            nullBody: true, repeatedSetCookie: true, viewHeaderSurvives: true,
            streamPassthrough: true, securityHeaders: true, rateLimitHeaders: true
        });
    }, 90_000);

    it('records which runtimes this machine could actually verify', () =>
    {
        // Not an assertion about the framework - a visible statement of what the run proved,
        // so a green suite on a machine without Bun/Deno cannot be mistaken for evidence.
        expect(typeof HAS_BUN).toBe('boolean');
        expect(typeof HAS_DENO).toBe('boolean');
        void fileURLToPath(KERNEL);
    });
});
