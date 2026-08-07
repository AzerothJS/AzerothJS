// @vitest-environment node
//
// The kernel-purity weld: the "." entry of @azerothjs/http must stay a pure
// fetch-standard kernel - importable on Cloudflare Workers, Deno Deploy, and Vercel
// Edge. Statically walks the module graph reachable from src/index.ts and asserts no
// `node:*` import exists ANYWHERE in it, with exactly one documented exception:
// request-root.ts's node:async_hooks (AsyncLocalStorage), the deliberately-portable
// choice implemented by Bun, Deno, and workerd. Everything genuinely Node-only
// (sockets, fs, zlib) must live behind the ./node subpath - adding a node: import to
// a kernel module fails HERE, not in a user's edge deploy.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** The single sanctioned node: import in the kernel graph. */
const ALLOWED: ReadonlyArray<{ file: string; specifier: string }> = [
    { file: 'request-root.ts', specifier: 'node:async_hooks' }
];

function importsOf(file: string): string[]
{
    const source = readFileSync(join(SRC, file), 'utf8');
    return [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
}

/** Resolves a relative specifier against the importing file's directory (SRC-relative paths). */
function resolveSpecifier(fromFile: string, specifier: string): string
{
    const parts = fromFile.split('/').slice(0, -1);
    for (const segment of specifier.split('/'))
    {
        if (segment === '.')
        {
            continue;
        }
        if (segment === '..')
        {
            parts.pop();
        }
        else
        {
            parts.push(segment);
        }
    }
    return parts.join('/');
}

/** Walks the SRC-relative module graph from `entry`; returns files seen + node: violations. */
function walkGraph(entry: string): { seen: Set<string>; violations: string[] }
{
    const seen = new Set<string>();
    const queue = [entry];
    const violations: string[] = [];
    while (queue.length > 0)
    {
        const file = queue.pop() as string;
        if (seen.has(file))
        {
            continue;
        }
        seen.add(file);
        for (const specifier of importsOf(file))
        {
            if (specifier.startsWith('node:'))
            {
                const sanctioned = ALLOWED.some((a) => a.file === file && a.specifier === specifier);
                if (!sanctioned)
                {
                    violations.push(`${ file } imports ${ specifier }`);
                }
            }
            else if (specifier.startsWith('.'))
            {
                queue.push(resolveSpecifier(file, specifier));
            }
        }
    }
    return { seen, violations };
}

describe('the fetch-standard kernel', () =>
{
    it('the "." module graph carries no node:* import beyond the AsyncLocalStorage seam', () =>
    {
        const { seen, violations } = walkGraph('index.ts');
        expect(violations).toEqual([]);
        expect(seen.size).toBeGreaterThan(10); // the walk genuinely covered the kernel
        // The node-only modules must NOT be reachable from the kernel entry at all.
        for (const nodeOnly of ['adapter-node.ts', 'static.ts', 'compress.ts'])
        {
            expect(seen.has(nodeOnly), `${ nodeOnly } must stay behind ./node`).toBe(false);
        }
    });

    it('the ./api contract layer is kernel-pure too (contracts mount on edge runtimes)', () =>
    {
        const { violations } = walkGraph('api/index.ts');
        expect(violations).toEqual([]);
    });

    it('the ./api/shared entry never reaches server code', () =>
    {
        const { seen, violations } = walkGraph('api/shared-entry.ts');
        expect(violations).toEqual([]);
        for (const serverOnly of ['api/feature.ts', 'api/register.ts', 'api/openapi.ts', 'api/explorer.ts'])
        {
            expect(seen.has(serverOnly), `${ serverOnly } must never enter a browser bundle`).toBe(false);
        }
    });

    it('app.handle answers in-process, but its response is NOT what a Fetch host accepts', async () =>
    {
        // This is the honest statement of the kernel's own contract, and it is why
        // `toFetchHandler` exists. `app.handle` returns a PayloadResponse: it satisfies
        // `instanceof Response` (so middleware and tests cannot tell), and the Node adapter
        // writes it straight to the socket. But a standard Fetch host checks the INTERNAL
        // slot, not the prototype - Bun answers `Expected a Response object`, Deno
        // `must be a Response constructed via the Response constructor in this realm`.
        //
        // The previous version of this test was named "an App is a bare WinterCG fetch
        // function" and asserted only `.status` and `.json()` - both of which a
        // PayloadResponse satisfies. It passed while the WinterCG claim was false on every
        // non-Node runtime. Asserting the shape is not asserting the contract.
        const { App, json } = await import('../src/index.ts');
        const { PayloadResponse } = await import('../src/payload.ts');
        const app = new App();
        app.get('/hello', () => json({ hi: true }));

        const response = await app.handle.bind(app)(new Request('http://edge.local/hello'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ hi: true });
        expect(response instanceof Response).toBe(true);        // indistinguishable to user code
        expect(response instanceof PayloadResponse).toBe(true); // ...but not host-acceptable
    });

    it('toFetchHandler returns a response a standard Fetch host will accept', async () =>
    {
        const { App, json, text, toFetchHandler } = await import('../src/index.ts');
        const { PayloadResponse } = await import('../src/payload.ts');
        const app = new App();
        app.get('/hello', () => json({ hi: true }));
        app.get('/plain', () => text('plain'));

        const fetchFn = toFetchHandler(app);
        for (const [path, expected] of [['/hello', '{"hi":true}'], ['/plain', 'plain']] as const)
        {
            const response = await fetchFn(new Request('http://edge.local' + path));
            // The invariant a host actually enforces: constructed by THIS realm's Response.
            expect(response instanceof PayloadResponse).toBe(false);
            expect(Object.getPrototypeOf(response)).toBe(Response.prototype);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe(expected);
        }
    });

    it('toFetchHandler preserves repeated Set-Cookie, which a header record cannot carry', async () =>
    {
        // A plain `Record<string, string>` holds one value per name, so a naive rebuild
        // collapses two cookies into one - session OR csrf, silently lost in production only.
        const { App, text, toFetchHandler } = await import('../src/index.ts');
        const app = new App();
        app.get('/login', () =>
        {
            const response = text('ok');
            response.headers.append('set-cookie', 'session=abc; Path=/');
            response.headers.append('set-cookie', 'csrf=xyz; Path=/');
            return response;
        });

        const response = await toFetchHandler(app)(new Request('http://edge.local/login'));
        expect(Object.getPrototypeOf(response)).toBe(Response.prototype);
        expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
    });

    it('toFetchHandler leaves an already-native response alone, streams included', async () =>
    {
        // Only kernel-built responses pay the materialisation; a streaming body must be
        // forwarded by reference, never buffered.
        const { App, toFetchHandler } = await import('../src/index.ts');
        const app = new App();
        const streamed = new Response(new ReadableStream({
            start(controller)
            {
                controller.enqueue(new TextEncoder().encode('chunk'));
                controller.close();
            }
        }), { status: 202 });
        app.get('/stream', () => streamed);

        const response = await toFetchHandler(app)(new Request('http://edge.local/stream'));
        expect(response).toBe(streamed); // same object - not rebuilt
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('chunk');
    });

    it('toFetchHandler builds a null-body status without throwing', async () =>
    {
        // `new Response(body, { status: 204 })` throws unless the body is null.
        const { App, toFetchHandler } = await import('../src/index.ts');
        const { noContent } = await import('../src/index.ts');
        const app = new App();
        app.get('/none', () => noContent());

        const response = await toFetchHandler(app)(new Request('http://edge.local/none'));
        expect(Object.getPrototypeOf(response)).toBe(Response.prototype);
        expect(response.status).toBe(204);
        expect(response.body).toBeNull();
    });
});
