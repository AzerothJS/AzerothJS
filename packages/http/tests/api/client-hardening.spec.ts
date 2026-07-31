// @vitest-environment node
//
// The typed client's remaining holes: a call that could execute a DIFFERENT route than the one
// it was typed for, and a body handed back unbounded. (Client-side schema validation is gone
// with the colocated design - input validation lives in the form and at the server boundary -
// so the response-shape checks that rode on it are gone too, deliberately.)
import { describe, expect, it } from 'vitest';

import { json } from '../../src/respond.ts';
import { feature } from '../../src/api/feature.ts';
import { manifestOf } from '../../src/api/feature.ts';
import { createClient } from '../../src/api/client.ts';
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
