// @vitest-environment node
//
// QUERY (RFC 10008) in a typed contract: `input` is the query body, validated exactly as a
// POST body. The client sends method QUERY with that body; the server reads and validates it,
// enforces the Content-Type, and validates the output - all two-sided through fetch: app.handle.

import { describe, it, expect } from 'vitest';
import { App } from '@azerothjs/http';
import { defineContract, route, implementContract, mountApi, createClient } from '@azerothjs/api';
import { object, string, number, array } from '@azerothjs/schema';

const contract = defineContract({
    products: {
        search: route({
            method: 'QUERY',
            path: '/products/search',
            input: object({ term: string(), tags: array(string()) }),
            output: object({ ids: array(number()) })
        })
    }
});

function server(): App
{
    const app = new App();
    const implementation = implementContract(contract, {
        products: {
            search: ({ input }) => ({ ids: input.term === 'sword' ? [1, 2] : [] })
        }
    });
    mountApi(app, implementation);
    return app;
}

describe('QUERY in a typed contract', () =>
{
    it('round-trips a QUERY through the inferred client and server', async () =>
    {
        const app = server();
        const client = createClient(contract, { baseUrl: '/api', fetch: (request) => app.handle(request) });

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

    it('pre-validates the query body on the client, before any request', async () =>
    {
        const app = server();
        let hit = false;
        const client = createClient(contract, {
            baseUrl: '/api',
            fetch: (request) =>
            {
                hit = true;
                return app.handle(request);
            }
        });
        // @ts-expect-error - tags must be a string array.
        await expect(client.products.search({ input: { term: 'sword', tags: 'weapon' } })).rejects.toThrow();
        expect(hit).toBe(false); // rejected locally; nothing crossed the wire
    });
});
