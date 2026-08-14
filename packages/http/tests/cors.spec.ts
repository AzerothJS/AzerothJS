// @vitest-environment node
//
// CORS and the shared `null` origin: browsers send the literal `Origin: null` for sandboxed
// frames and data:/file: documents, so countless distinct documents share it - it must never
// gain credentials under ANY origin form. Preflight answers must also carry every inner
// Set-Cookie: a record holds one value per name and would keep only the last.

import { describe, it, expect } from 'vitest';
import { App, pipeline, cors, text, type CorsOrigin } from '@azerothjs/http';

describe('cors credentials never combine with the null origin', () =>
{
    it.each<[string, CorsOrigin]>([
        ['string', 'null'],
        ['array', ['https://good.example', 'null']]
    ])('refuses a literal null origin with credentials at wiring time (%s form)', (_form, origin) =>
    {
        expect(() => cors({ origin, credentials: true })).toThrow(/null/);
    });

    it('denies the null origin at runtime when a predicate under credentials allows it', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin: () => true, credentials: true }));

        const response = await handler.handle(new Request('http://local/', { headers: { origin: 'null' } }));
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it.each<[string, CorsOrigin]>([
        ['string', 'null'],
        ['array', ['null']],
        ['predicate', (origin: string): boolean => origin === 'null']
    ])('still admits the null origin WITHOUT credentials (%s form)', async (_form, origin) =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin }));

        const response = await handler.handle(new Request('http://local/', { headers: { origin: 'null' } }));
        expect(response.headers.get('access-control-allow-origin')).toBe('null');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('keeps reflecting a trusted concrete origin with credentials', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin: ['https://good.example'], credentials: true }));

        const response = await handler.handle(new Request('http://local/', { headers: { origin: 'https://good.example' } }));
        expect(response.headers.get('access-control-allow-origin')).toBe('https://good.example');
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });
});

describe('cors preflight header copy', () =>
{
    it('carries every inner Set-Cookie onto the 204, not just the last', async () =>
    {
        const app = new App();
        app.route('OPTIONS', '/data', () =>
        {
            const headers = new Headers();
            headers.append('set-cookie', 'session=s1; Path=/');
            headers.append('set-cookie', 'csrf=c1; Path=/');
            return new Response('metered', { headers });
        });
        const handler = pipeline(app, cors({ origin: ['https://good.example'] }));

        const response = await handler.handle(new Request('http://local/data', {
            method: 'OPTIONS',
            headers: { origin: 'https://good.example', 'access-control-request-method': 'POST' }
        }));
        expect(response.status).toBe(204);
        expect(response.headers.getSetCookie()).toEqual(['session=s1; Path=/', 'csrf=c1; Path=/']);
        expect(response.headers.get('access-control-allow-origin')).toBe('https://good.example');
    });
});
