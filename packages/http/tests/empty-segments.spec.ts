// @vitest-environment node
//
// An empty path segment is a real, significant segment (RFC 3986 3.3), and RFC 3986 6.2.2 does
// NOT list removing one among the normalizations that preserve equivalence - dot-segments are
// listed, empty segments are not. `//admin` and `/admin` are different URIs.
//
// The router collapsed every empty segment, so `//admin`, `/admin//panel` and `/admin//` all
// reached the `/admin/panel` handler. Differential testing put AzerothJS alone on that: Express,
// Fastify, Hono and Koa all 404. Being the permissive outlier is what makes it a security bug
// rather than a quirk, in two directions:
//
//   - Anything in FRONT keyed on the spelling the client sent - an nginx `location`, a WAF rule,
//     an API-gateway ACL - does not match `//admin`, forwards it verbatim, and the app serves it.
//   - Anything ABOVE written on `context.url.pathname`, the standard accessor every developer
//     reaches for, sees `//admin` while the router sees `/admin`. `startsWith('/admin')` is false
//     and the handler runs anyway.
//
// Trailing-slash equivalence (`/admin` == `/admin/`) is deliberate, matches Express, and is
// preserved: it cannot shift a prefix, so it does not create the same disagreement.
import { describe, expect, it } from 'vitest';

import { App, HttpError, text } from '../src/index.ts';
import { RadixRouter } from '../src/router.ts';

describe('empty path segments are not collapsed', () =>
{
    it.each(['//admin/panel', '///admin/panel', '/admin//panel', '/admin/panel//', '//admin//panel//'])('misses %s', (path) =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/admin/panel', 'ADMIN');

        expect(router.match('GET', path).kind).toBe('miss');
    });

    it.each(['/admin/panel', '/admin/panel/'])('still matches %s', (path) =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/admin/panel', 'ADMIN');

        const result = router.match('GET', path);
        expect(result.kind).toBe('match');
    });

    it('still serves the root', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/', 'ROOT');

        expect(router.match('GET', '/').kind).toBe('match');
    });

    it('does not let a param capture an empty segment', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/a/:x/c', 'PARAM');

        expect(router.match('GET', '/a//c').kind).toBe('miss');
        expect(router.match('GET', '/a/b/c').kind).toBe('match');
    });

    it('leaves an ENCODED double slash inside a value alone', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/files/*path', 'FILES');

        // The client sent one segment whose value contains slashes, not two empty segments.
        const result = router.match('GET', '/files/a%2F%2Fb');
        expect(result.kind).toBe('match');
        if (result.kind === 'match')
        {
            expect(result.params.path).toBe('a//b');
        }
    });
});

describe('a prefix guard written on url.pathname can no longer be walked around', () =>
{
    const build = (): App =>
    {
        const app = new App({ dev: false });
        app.use((context) =>
        {
            if (context.url.pathname.startsWith('/admin') && context.request.headers.get('authorization') === null)
            {
                throw new HttpError(403, 'Forbidden', { code: 'forbidden' });
            }
            return {};
        });
        app.get('/admin/panel', () => text('SECRET ADMIN DATA'));
        return app;
    };

    it.each(['/admin/panel', '//admin/panel', '///admin/panel', '/admin//panel'])('never serves the secret for %s', async (path) =>
    {
        const response = await build().handle(new Request(`http://local${ path }`));
        const body = await response.text();

        expect(body).not.toContain('SECRET ADMIN DATA');
        expect([403, 404]).toContain(response.status);
    });

    it('still serves it to an authorized caller', async () =>
    {
        const response = await build().handle(new Request('http://local/admin/panel', { headers: { authorization: 'Bearer x' } }));

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('SECRET ADMIN DATA');
    });
});
