// @vitest-environment node
//
// HSTS reads the forwarded proto claim by the same rule the request URL is built from, so one
// deployment cannot be secure enough for `context.url` and not secure enough for the header.

import { describe, it, expect } from 'vitest';
import { App, pipeline, securityHeaders, text } from '@azerothjs/http';

const HSTS = 'strict-transport-security';

/** The response of a plain GET through securityHeaders with HSTS enabled. */
async function get(headers: Record<string, string>, trustProxy: boolean): Promise<Response>
{
    const app = new App();
    app.get('/', () => text('ok'));
    const handler = pipeline(app, securityHeaders({ hsts: { maxAgeSeconds: 100 }, trustProxy }));
    return await handler.handle(new Request('http://local/', { headers }));
}

describe('HSTS and the forwarded proto claim', () =>
{
    it('believes the value a replacing proxy left, whatever its case', async () =>
    {
        expect((await get({ 'x-forwarded-proto': 'https' }, true)).headers.get(HSTS)).toBe('max-age=100; includeSubDomains');
        expect((await get({ 'x-forwarded-proto': 'HTTPS' }, true)).headers.get(HSTS)).toBe('max-age=100; includeSubDomains');
    });

    it('takes the last-written entry when a client value survives beside the proxy value', async () =>
    {
        expect((await get({ 'x-forwarded-proto': 'gopher, https' }, true)).headers.get(HSTS)).not.toBeNull();
        expect((await get({ 'x-forwarded-proto': 'https, http' }, true)).headers.get(HSTS)).toBeNull();
    });

    it('proves nothing without trustProxy, whatever the client writes', async () =>
    {
        expect((await get({ 'x-forwarded-proto': 'https' }, false)).headers.get(HSTS)).toBeNull();
        expect((await get({ 'x-forwarded-proto': 'gopher, https' }, false)).headers.get(HSTS)).toBeNull();
    });
});
