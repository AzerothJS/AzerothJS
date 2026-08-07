// @vitest-environment node
//
// `redirect` and `noContent` built a plain `Response` instead of going through the kernel's
// `payloadResponse`. Two consequences, both real:
//
//   1. Neither could carry a `Set-Cookie`. Sign-out is "expire the session cookie AND redirect",
//      and a logout that redirects without clearing the cookie leaves the user signed in.
//   2. Both lost the PayloadResponse fast path the Node adapter uses (writeHead + end, no
//      web-stream), so the two most common bodyless replies were the slowest to write.
import { describe, expect, it } from 'vitest';
import { App, expireCookie, noContent, redirect, serializeCookie, pipeline, requestId, securityHeaders, text, toFetchHandler } from '@azerothjs/http';

// A response carries its headers in one of TWO places: the construction-time record, or the
// `headers` view once someone touched it. `withHeaders` - which every edge middleware calls -
// rebuilt from the record alone, so ANY middleware silently discarded everything written
// through the standard `response.headers.set/append` API. `raw()` handled this correctly, one
// method above; the two answered the same question differently. Both now read one helper.
describe('edge middleware preserves headers written through the `headers` view', () =>
{
    const withViewHeaders = (): App =>
    {
        const app = new App({ dev: true });
        app.get('/h', () =>
        {
            const response = text('ok');
            response.headers.set('cache-control', 'no-store');
            response.headers.set('x-custom', 'kept');
            response.headers.append('set-cookie', 'session=abc; Path=/');
            response.headers.append('set-cookie', 'csrf=xyz; Path=/');
            return response;
        });
        return app;
    };

    it('a single edge middleware keeps no-store, custom headers, and every cookie', async () =>
    {
        // `Cache-Control: no-store` vanishing is the quiet one: the response stays correct
        // while becoming cacheable by proxies and browsers.
        const piped = pipeline(withViewHeaders(), requestId());
        const response = await piped.handle(new Request('http://x/h'));
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-custom')).toBe('kept');
        expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
    });

    it('the full production pipeline keeps them too, and so does the Fetch adapter', async () =>
    {
        // This is the shape every scaffolded template ships.
        const piped = pipeline(withViewHeaders(), requestId(), securityHeaders());
        const direct = await piped.handle(new Request('http://x/h'));
        expect(direct.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
        expect(direct.headers.get('cache-control')).toBe('no-store');

        const viaFetch = await toFetchHandler(piped)(new Request('http://x/h'));
        expect(viaFetch.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
        expect(viaFetch.headers.get('cache-control')).toBe('no-store');
        expect(viaFetch.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('a middleware-added header still merges with the view ones, not over them', async () =>
    {
        const piped = pipeline(withViewHeaders(), requestId());
        const response = await piped.handle(new Request('http://x/h'));
        expect(response.headers.get('x-request-id')).toBeTruthy(); // added by the middleware
        expect(response.headers.get('x-custom')).toBe('kept');     // and the view's survived
    });

    it('clone() carries the view headers too', () =>
    {
        // `withHeaders` was not the only method reading the construction-time record: `clone`
        // and the lazily-materialised real Response did the same, so the same loss reappeared
        // through a different door. All three now read one helper.
        const response = text('ok');
        response.headers.set('cache-control', 'no-store');
        response.headers.append('set-cookie', 'session=abc');

        const cloned = response.clone();
        expect(cloned.headers.get('cache-control')).toBe('no-store');
        expect(cloned.headers.getSetCookie()).toEqual(['session=abc']);
    });
});

describe('bodyless responses carry cookies', () =>
{
    it('a redirect can clear the session cookie - the sign-out flow', async () =>
    {
        const app = new App();
        app.post('/sign-out', () => redirect('/login', 303, {
            headers: { 'set-cookie': expireCookie('session') }
        }));

        const response = await app.handle(new Request('http://local/sign-out', { method: 'POST' }));
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/login');
        expect(response.headers.getSetCookie()).toHaveLength(1);
        expect(response.headers.getSetCookie()[0]).toContain('session=');
    });

    it('a redirect preserves EVERY cookie, not just the last', async () =>
    {
        const response = redirect('/next', 303, {
            headers: [
                ['set-cookie', serializeCookie('session', 'abc')],
                ['set-cookie', serializeCookie('csrf', 'xyz')]
            ]
        });
        // Header iteration collapses duplicate set-cookie; only getSetCookie preserves both.
        expect(response.headers.getSetCookie()).toHaveLength(2);
    });

    it('a 204 can carry a cookie and still sends no body or length', async () =>
    {
        const response = noContent({ headers: { 'set-cookie': serializeCookie('seen', '1') } });
        expect(response.status).toBe(204);
        expect(response.headers.getSetCookie()).toHaveLength(1);
        // RFC 9112 6.2: a 204 must not declare a length.
        expect(response.headers.get('content-length')).toBeNull();
        expect(await response.text()).toBe('');
    });

    it('redirect still defaults to 303 and needs no options', () =>
    {
        const response = redirect('/somewhere');
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/somewhere');
    });
});
