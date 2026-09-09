// @vitest-environment node
//
// CSRF: the double-submit cookie plus origin policy. csrfCookie mints the readable token
// at the edge; csrfProtect is a guard rejecting any state-changing request whose caller
// cannot read the cookie - which a cross-site attacker, by definition, cannot.
import { describe, expect, it } from 'vitest';

import { App, csrfCookie, csrfProtect, csrfToken, json, noContent, pipeline, text } from '@azerothjs/http';

const TOKEN = csrfToken();

function protectedApp(options: Parameters<typeof csrfProtect>[0] = { secure: false }): App
{
    const app = new App();
    app.get('/page', () => json({ ok: true }));
    const guarded = app.with(csrfProtect(options));
    guarded.post('/submit', () => json({ done: true }));
    return app;
}

function post(app: App, headers: Record<string, string>): Promise<Response>
{
    return app.handle(new Request('http://local/submit', { method: 'POST', headers }));
}

const pair = { cookie: `azcsrf=${ TOKEN }`, 'x-azeroth-csrf': TOKEN };

describe('csrfToken', () =>
{
    it('mints an unpredictable base64url token of at least 32 chars', () =>
    {
        const one = csrfToken();
        const two = csrfToken();
        expect(one).not.toBe(two);
        expect(one.length).toBeGreaterThanOrEqual(32);
        expect(one).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('csrfCookie', () =>
{
    const build = (secure: boolean): { handle(request: Request): Promise<Response> } =>
    {
        const app = new App();
        app.get('/page', () => json({ ok: true }));
        app.get('/cookie-too', () => new Response(null, { status: 200, headers: { 'set-cookie': 'other=1' } }));
        return pipeline(app, csrfCookie({ secure }));
    };

    it('mints __Host-azcsrf on a GET without the cookie: Secure, SameSite=Lax, Path=/, NOT HttpOnly', async () =>
    {
        const response = await build(true).handle(new Request('http://local/page'));
        const cookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-azcsrf='));
        expect(cookie).toBeDefined();
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
        expect(cookie).not.toContain('HttpOnly');
    });

    it('secure: false uses the azcsrf name with no Secure attribute (plain-http dev)', async () =>
    {
        const response = await build(false).handle(new Request('http://local/page'));
        const cookie = response.headers.getSetCookie().find((value) => value.startsWith('azcsrf='));
        expect(cookie).toBeDefined();
        expect(cookie).not.toContain('Secure');
    });

    it('a request already carrying the cookie gets no new Set-Cookie', async () =>
    {
        const response = await build(false).handle(new Request('http://local/page', { headers: { cookie: `azcsrf=${ TOKEN }` } }));
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('APPENDS: a handler-set cookie survives the minting', async () =>
    {
        const response = await build(false).handle(new Request('http://local/cookie-too'));
        const cookies = response.headers.getSetCookie();
        expect(cookies.some((value) => value.startsWith('other=1'))).toBe(true);
        expect(cookies.some((value) => value.startsWith('azcsrf='))).toBe(true);
    });

    it('mints on bodyless statuses - Set-Cookie is legal on a 204 and a 304', async () =>
    {
        const app = new App();
        app.get('/none', () => noContent());
        app.get('/cached', () => text('', { status: 304 }));
        const handler = pipeline(app, csrfCookie({ secure: false }));

        const none = await handler.handle(new Request('http://local/none'));
        expect(none.status).toBe(204);
        expect(none.headers.getSetCookie().some((value) => value.startsWith('azcsrf='))).toBe(true);

        const cached = await handler.handle(new Request('http://local/cached'));
        expect(cached.status).toBe(304);
        expect(cached.headers.getSetCookie().some((value) => value.startsWith('azcsrf='))).toBe(true);
    });
});

describe('csrfProtect', () =>
{
    it('safe methods pass with nothing', async () =>
    {
        const app = protectedApp();
        expect((await app.handle(new Request('http://local/page'))).status).toBe(200);
    });

    it('a POST with the matching pair passes', async () =>
    {
        expect((await post(protectedApp(), pair)).status).toBe(200);
    });

    it('missing cookie, missing header, or a mismatch is a 403 with code csrf', async () =>
    {
        const app = protectedApp();
        for (const headers of [
            { 'x-azeroth-csrf': TOKEN },
            { cookie: `azcsrf=${ TOKEN }` },
            { cookie: `azcsrf=${ TOKEN }`, 'x-azeroth-csrf': csrfToken() }
        ])
        {
            const response = await post(app, headers);
            expect(response.status).toBe(403);
            const body = await response.json() as { error: { code: string } };
            expect(body.error.code).toBe('csrf');
        }
    });

    it('a token shorter than 16 chars is rejected even when mirrored', async () =>
    {
        const response = await post(protectedApp(), { cookie: 'azcsrf=short', 'x-azeroth-csrf': 'short' });
        expect(response.status).toBe(403);
    });

    it('sec-fetch-site cross-site and same-site are rejected; same-origin and none pass', async () =>
    {
        const app = protectedApp();
        expect((await post(app, { ...pair, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
        expect((await post(app, { ...pair, 'sec-fetch-site': 'same-site' })).status).toBe(403);
        expect((await post(app, { ...pair, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
        expect((await post(app, { ...pair, 'sec-fetch-site': 'none' })).status).toBe(200);
    });

    it('a mismatched or null Origin is rejected; the request origin and allowlisted origins pass', async () =>
    {
        const app = protectedApp();
        expect((await post(app, { ...pair, origin: 'http://evil.example' })).status).toBe(403);
        expect((await post(app, { ...pair, origin: 'null' })).status).toBe(403);
        expect((await post(app, { ...pair, origin: 'http://local' })).status).toBe(200);

        const allowing = protectedApp({ secure: false, allowedOrigins: ['http://trusted.example'] });
        expect((await post(allowing, { ...pair, origin: 'http://trusted.example' })).status).toBe(200);
        expect((await post(allowing, { ...pair, origin: 'http://evil.example' })).status).toBe(403);
    });

    // A browser blanks the Origin on a same-origin navigation POST from a page served with
    // `Referrer-Policy: no-referrer`, which securityHeaders() sets by default - so a plain
    // <form method="post"> on a scaffolded app arrived as (null, same-origin) and was refused.
    // The value says nothing on its own; Sec-Fetch-Site is what tells the two cases apart, and
    // it is a forbidden header name, so no page can forge it.
    describe('a blanked Origin is judged by the header a page cannot set', () =>
    {
        it('is accepted when the browser vouches for it, and only then', async () =>
        {
            const app = protectedApp();
            expect((await post(app, { ...pair, origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
            // `none` means there was NO initiator, which no same-origin form submit produces.
            expect((await post(app, { ...pair, origin: 'null', 'sec-fetch-site': 'none' })).status).toBe(403);
            // Nothing vouching: fail closed, exactly as before this rule existed.
            expect((await post(app, { ...pair, origin: 'null' })).status).toBe(403);
            expect((await post(app, { ...pair, origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
            expect((await post(app, { ...pair, origin: 'null', 'sec-fetch-site': 'same-site' })).status).toBe(403);
        });

        it('excuses only the exact literal, never a real foreign origin', async () =>
        {
            // THE ARM THAT CARRIES THE WEIGHT. An implementation that treats any non-matching
            // Origin as blanked once the browser says same-origin passes every other arm here
            // while admitting an attacker's own origin outright.
            const app = protectedApp();
            expect((await post(app, { ...pair, origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' })).status).toBe(403);
            expect((await post(app, { ...pair, origin: '', 'sec-fetch-site': 'same-origin' })).status).toBe(403);
            expect((await post(app, { ...pair, origin: 'NULL', 'sec-fetch-site': 'same-origin' })).status).toBe(403);
        });

        it('is never re-admitted by an allowlist entry, however the site is configured', async () =>
        {
            // Allowlisting the literal would hand every cross-site caller a bypass, since any
            // page can blank its own Origin with one meta tag. `cors()` refuses the same string.
            const allowing = protectedApp({ secure: false, allowedOrigins: ['null'] });
            expect((await post(allowing, { ...pair, origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
            expect((await post(allowing, { ...pair, origin: 'null' })).status).toBe(403);
        });

        it('still requires the mirrored token', async () =>
        {
            const app = protectedApp();
            const response = await post(app, {
                cookie: `azcsrf=${ TOKEN }`, 'x-azeroth-csrf': 'a-different-token-entirely',
                origin: 'null', 'sec-fetch-site': 'same-origin'
            });
            expect(response.status).toBe(403);
            expect(((await response.json()) as { error: { code: string } }).error.code).toBe('csrf');
        });
    });

    it('a scheme-only mismatch with a forwarded proto names trustProxy; other rejections stay terse', async () =>
    {
        const app = protectedApp();

        // Same host, https Origin, http URL, x-forwarded-proto present: a TLS terminator in
        // front of a serve() without trustProxy. Still a 403, but the message names the fix.
        const proxied = await post(app, { ...pair, origin: 'https://local', 'x-forwarded-proto': 'https' });
        expect(proxied.status).toBe(403);
        const proxiedBody = await proxied.json() as { error: { code: string; message: string } };
        expect(proxiedBody.error.code).toBe('csrf');
        expect(proxiedBody.error.message).toContain('trustProxy');

        // A genuinely foreign origin gets no hint even with the forwarded header along.
        const hostile = await post(app, { ...pair, origin: 'https://evil.example', 'x-forwarded-proto': 'https' });
        expect(hostile.status).toBe(403);
        const hostileBody = await hostile.json() as { error: { message: string } };
        expect(hostileBody.error.message).not.toContain('trustProxy');

        // Without proxy evidence the same scheme mismatch stays terse too.
        const bare = await post(app, { ...pair, origin: 'https://local' });
        expect(bare.status).toBe(403);
        const bareBody = await bare.json() as { error: { message: string } };
        expect(bareBody.error.message).not.toContain('trustProxy');
    });
});
