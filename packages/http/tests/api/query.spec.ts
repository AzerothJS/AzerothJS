// @vitest-environment node
//
// QUERY (RFC 10008) as a declared route: `input` is the query body, validated exactly as a
// POST body. The client sends method QUERY with that body; the server reads and validates it,
// enforces the Content-Type, and validates the output - all two-sided through fetch: app.handle.
import { describe, it, expect } from 'vitest';
import { App } from '../../src/app.ts';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { createClient } from '../../src/api/client.ts';
import { object, string, number, array } from '@azerothjs/schema';

const products = feature('/products', (routes) => ({
    search: routes.query('/search', {
        input: object({ term: string(), tags: array(string()) }),
        output: object({ ids: array(number()) })
    }, ({ input }) => ({ ids: input.term === 'sword' ? [1, 2] : [] }))
}));

const api = { products };

function server(): App
{
    const app = new App();
    register(app, api);
    return app;
}

describe('QUERY as a declared route', () =>
{
    it('round-trips a QUERY through the inferred client and server', async () =>
    {
        const app = server();
        const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request) => app.handle(request) });

        const result = await client.products.search({ input: { term: 'sword', tags: ['weapon'] } });
        expect(result).toEqual({ ids: [1, 2] });
    });

    it('rejects a forged QUERY body with 422 field errors', async () =>
    {
        const app = server();
        const response = await app.handle(new Request('http://local/api/products/search', {
            method: 'QUERY',
            body: JSON.stringify({ term: 123, tags: 'weapon' }), // term must be string, tags an array
            headers: { 'content-type': 'application/json' },
            duplex: 'half'
        } as RequestInit));
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { details: { fields: Record<string, string> } } };
        expect(body.error.details.fields).toHaveProperty('term');
        expect(body.error.details.fields).toHaveProperty('tags');
    });

    it('rejects a QUERY without the JSON Content-Type (415)', async () =>
    {
        const app = server();
        const response = await app.handle(new Request('http://local/api/products/search', {
            method: 'QUERY',
            body: JSON.stringify({ term: 'sword', tags: [] }),
            headers: { 'content-type': 'text/plain' },
            duplex: 'half'
        } as RequestInit));
        expect(response.status).toBe(415);
    });
});
