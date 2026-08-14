// @vitest-environment node
//
// The typed client's remaining holes: a call that could execute a DIFFERENT route than the one
// it was typed for, and a body handed back unbounded. (Client-side schema validation is gone
// with the colocated design - input validation lives in the form and at the server boundary -
// so the response-shape checks that rode on it are gone too, deliberately.)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { json } from '../../src/respond.ts';
import { feature } from '../../src/api/feature.ts';
import { manifestOf } from '../../src/api/feature.ts';
import { createClient, ApiError } from '../../src/api/client.ts';
import { object, string, number } from '@azerothjs/schema';

const files = feature('/files', (routes) => ({
    read: routes.get('/*path', { output: object({ path: string() }) }, (context) => ({ path: context.params.path }))
}));
const me = feature('/me', (routes) => ({
    read: routes.get('/', { output: object({ id: number() }) }, () => ({ id: 1 }))
}));

const api = { files, me };
const manifest = manifestOf(api);

describe('a client call cannot leave the route it was typed for', () =>
{
    it('a traversal in a wildcard param is refused instead of retargeting the call', async () =>
    {
        const seen: string[] = [];
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            fetch: (request) =>
            {
                seen.push(new URL(request.url).pathname);
                return Promise.resolve(json({ path: 'ok' }));
            }
        });

        await expect(client.files.read({ params: { path: '../../admin/keys' } })).rejects.toThrow(/may not contain/);
        expect(seen).toEqual([]);
    });

    it('an ordinary multi-segment wildcard still works, and its segments are encoded', async () =>
    {
        const seen: string[] = [];
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            fetch: (request) =>
            {
                seen.push(new URL(request.url).pathname);
                return Promise.resolve(json({ path: 'ok' }));
            }
        });

        await client.files.read({ params: { path: 'docs/a b/report.pdf' } });
        expect(seen).toEqual(['/files/docs/a%20b/report.pdf']);
    });
});

describe('the client bounds what it is handed', () =>
{
    it('an oversized body is refused before it is parsed', async () =>
    {
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            maxResponseBytes: 64,
            fetch: () => Promise.resolve(json({ id: 1, padding: 'x'.repeat(500) }))
        });

        await expect(client.me.read()).rejects.toMatchObject({ code: 'response-too-large' });
    });

    it('stops READING at the cap instead of buffering the whole body first', async () =>
    {
        // The cap was applied after `await response.text()`, which is exactly as unbounded as the
        // `response.json()` this function exists to replace: the memory was already spent by the
        // time the limit was consulted. A stream that never ends proves the difference - if the
        // body is drained first this never returns, so the assertion can only pass by cancelling.
        let pushed = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller)
            {
                pushed += 1;
                controller.enqueue(new Uint8Array(1024));
            }
        });
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            maxResponseBytes: 4096,
            fetch: () => Promise.resolve(new Response(endless, {
                status: 200,
                headers: { 'content-type': 'application/json' }
            }))
        });

        await expect(client.me.read()).rejects.toMatchObject({ code: 'response-too-large' });
        // Refused a few chunks in, not after an unbounded read.
        expect(pushed).toBeLessThan(64);
    });

    it('counts BYTES, not UTF-16 code units', async () =>
    {
        // `text.length` counts code units, so a body of 3-byte UTF-8 characters reached up to
        // three times the configured cap before tripping it - the option did not mean what it
        // said. 200 characters of U+4E2D is 600 bytes on the wire and 200 by the old measure.
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            maxResponseBytes: 400,
            fetch: () => Promise.resolve(json({ id: 1, padding: '中'.repeat(200) }))
        });

        await expect(client.me.read()).rejects.toMatchObject({ code: 'response-too-large' });
    });

    it('a 2xx that is not JSON rejects with the documented ApiError, never a bare SyntaxError', async () =>
    {
        // A gateway or captive portal answering 200 with an HTML page is the common shape.
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            fetch: () => Promise.resolve(new Response('<!doctype html><title>gateway</title>', {
                status: 200,
                headers: { 'content-type': 'text/html' }
            }))
        });

        const failure = await client.me.read().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect(failure).toMatchObject({ status: 200, code: 'malformed-json' });
    });

    it('a non-JSON error body still maps to the status-derived ApiError', async () =>
    {
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            fetch: () => Promise.resolve(new Response('<!doctype html>bad gateway', {
                status: 502,
                headers: { 'content-type': 'text/html' }
            }))
        });

        const failure = await client.me.read().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect(failure).toMatchObject({ status: 502, code: 'unknown' });
    });

    it('a SUCCESS body that is not JSON surfaces the documented error, not a bare SyntaxError', async () =>
    {
        // A 2xx from a proxy error page or a misconfigured gateway: the decode failure must
        // still reach the caller as the contract shape every call site already handles.
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            fetch: () => Promise.resolve(new Response('<!doctype html>hello', {
                status: 200,
                headers: { 'content-type': 'text/html' }
            }))
        });

        const failure = await client.me.read().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect(failure).not.toBeInstanceOf(SyntaxError);
    });

    it('a redirect is an error, never a followed hop carrying the auth headers', async () =>
    {
        const client = createClient<typeof api>(manifest, {
            baseUrl: '',
            headers: { 'x-api-key': 'super-secret' },
            // The transport receives the Request; `redirect: 'error'` is what stops a real fetch
            // from following a Location off-origin with these headers attached.
            fetch: (request) => Promise.resolve(json({ redirect: request.redirect }))
        });

        const seen = await client.me.read().catch(() => undefined) as unknown as { redirect?: string } | undefined;
        expect(seen?.redirect ?? 'error').toBe('error');
    });
});

describe('the shared entry stays browser-pure', () =>
{
    // The bundle-exclusion proof for server actions: a client importing the typed surface
    // (createClient, applyFieldErrors, Wire) can never drag server code along, because the
    // module graph reachable from shared-entry.ts IS this allowlist - feature.ts,
    // register.ts, and the kernel simply are not in it. Adding an import that widens the
    // graph fails here, not in a user's bundle analyzer.
    it('reaches only the client-safe modules and no node: import', () =>
    {
        const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
        const importsOf = (file: string): string[] =>
        {
            const source = readFileSync(join(src, file), 'utf8');
            return [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
        };
        const resolveSpecifier = (fromFile: string, specifier: string): string =>
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
        };
        const seen = new Set<string>();
        const queue = ['api/shared-entry.ts'];
        const nodeImports: string[] = [];
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
                    nodeImports.push(`${ file } imports ${ specifier }`);
                }
                else if (specifier.startsWith('.'))
                {
                    queue.push(resolveSpecifier(file, specifier));
                }
            }
        }
        expect(nodeImports).toEqual([]);
        expect([...seen].sort()).toEqual([
            'api/client.ts',
            'api/declare.ts',
            'api/manifest-handoff.ts',
            'api/shared-entry.ts'
        ]);
    });
});
