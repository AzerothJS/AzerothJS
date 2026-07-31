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
import { App, expireCookie, noContent, redirect, serializeCookie } from '@azerothjs/http';

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
