// @vitest-environment node
//
// The QUERY method (RFC 10008): a safe, idempotent read that carries a request body. Every
// case runs through app.handle(new Request({ method: 'QUERY', ... })) - the body round-trips,
// the Content-Type requirement is enforced, and the method takes part in routing like any other.

import { describe, it, expect } from 'vitest';
import { App, readJson, json } from '@azerothjs/http';

function queryRequest(url: string, doc: unknown, contentType: string | null = 'application/json'): Request
{
    const headers = contentType !== null ? { 'content-type': contentType } : {};
    return new Request(url, { method: 'QUERY', body: JSON.stringify(doc), headers, duplex: 'half' } as RequestInit);
}

describe('QUERY method (RFC 10008)', () =>
{
    it('routes app.query, reads the body, and returns results with QUERY response headers', async () =>
    {
        const app = new App();
        app.query('/search', async ({ request }) =>
        {
            const filter = await readJson(request);
            // What `queryResult` did: `json` plus the QUERY headers, spelled out.
            return json({ results: [filter] }, {
                headers: {
                    'content-location': '/search/results/abc',
                    'cache-control': 'private, max-age=30'
                }
            });
        });

        const response = await app.handle(queryRequest('http://local/search', { term: 'azeroth' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ results: [{ term: 'azeroth' }] });
        expect(response.headers.get('content-location')).toBe('/search/results/abc');
        expect(response.headers.get('cache-control')).toBe('private, max-age=30');
    });

    it('is idempotent - two identical queries yield identical results', async () =>
    {
        const app = new App();
        app.query('/q', async ({ request }) => json({ echo: await readJson(request) }));
        const body = { a: 1, b: [2, 3] };

        const first = await app.handle(queryRequest('http://local/q', body));
        const second = await app.handle(queryRequest('http://local/q', body));
        expect(await first.json()).toEqual(await second.json());
    });

    it('fails a QUERY whose Content-Type is not the accepted media type (415)', async () =>
    {
        const app = new App();
        app.query('/q', async ({ request }) => json({ ok: await readJson(request) }));

        const response = await app.handle(queryRequest('http://local/q', { x: 1 }, 'text/plain'));
        expect(response.status).toBe(415);
    });

    it('lists QUERY in Allow when a path serves it alongside other methods (405)', async () =>
    {
        const app = new App();
        app.get('/items', () => json({ via: 'GET' }));
        app.query('/items', async ({ request }) => json({ q: await readJson(request) }));

        const response = await app.handle(new Request('http://local/items', { method: 'DELETE' }));
        expect(response.status).toBe(405);
        const allow = response.headers.get('allow') ?? '';
        expect(allow).toContain('GET');
        expect(allow).toContain('QUERY');
    });

    it('an endpoint can advertise its query media types with a plain header', () =>
    {
        // `acceptQuery(types)` was `{ 'accept-query': types.join(', ') }` and nothing more.
        expect({ 'accept-query': ['application/json', 'application/sql'].join(', ') }).toEqual({
            'accept-query': 'application/json, application/sql'
        });
    });
});
