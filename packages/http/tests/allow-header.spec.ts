// @vitest-environment node
//
// RFC 9110 15.5.6 requires a 405 to carry `Allow`, and 10.2.1 defines it as "the set of methods
// supported by the target resource". AzerothJS sends the header - which Express, Fastify and Hono
// do not, since they answer 404 for this case at all - but built the set from the raw handler
// keys, which never contain HEAD. The router serves HEAD off a GET registration, so the advertised
// set omitted a method the server demonstrably answers. Clients act on this field; an incomplete
// one is a machine-readable lie.
import { describe, expect, it } from 'vitest';

import { App, json } from '../src/index.ts';
import { RadixRouter } from '../src/router.ts';

describe('the Allow set names every method the resource answers', () =>
{
    it('includes HEAD wherever GET is registered', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/m', 'GET-M');

        const result = router.match('POST', '/m');

        expect(result.kind).toBe('method-mismatch');
        if (result.kind === 'method-mismatch')
        {
            expect(result.allowed).toEqual(['GET', 'HEAD']);
        }
    });

    it('does not invent HEAD when GET is not registered', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('POST', '/m', 'POST-M');

        const result = router.match('DELETE', '/m');

        expect(result.kind).toBe('method-mismatch');
        if (result.kind === 'method-mismatch')
        {
            expect(result.allowed).toEqual(['POST']);
        }
    });

    it('advertises exactly what the server answers, end to end', async () =>
    {
        const app = new App({ dev: false });
        app.get('/m', () => json({ ok: 1 }));

        const head = await app.handle(new Request('http://local/m', { method: 'HEAD' }));
        expect(head.status).toBe(200);

        const refused = await app.handle(new Request('http://local/m', { method: 'POST' }));
        expect(refused.status).toBe(405);
        expect(refused.headers.get('allow')).toBe('GET, HEAD');
    });
});
