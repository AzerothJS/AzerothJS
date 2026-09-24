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
        // A session cookie: a token handed out lives as long as the browser session holding it.
        expect(cookie).not.toMatch(/max-age|expires/i);
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

describe('csrfCookie and a shared cache', () =>
{
    const minted = (response: Response): boolean => response.headers.getSetCookie().some((line) => line.startsWith('azcsrf='));

    it('never mints on a response a shared cache may store, and marks one that names no policy private', async () =>
    {
        const policies: Record<string, string> = {
            isr: 'public, max-age=0, must-revalidate',
            asset: 'public, max-age=31536000, immutable',
            maxAge: 'max-age=60',
            noCache: 'no-cache',
            sMaxage: 's-maxage=60',
            qualifiedPrivate: 'private="set-cookie", max-age=60',
            private: 'private',
            noStore: 'no-store',
            mixedCase: 'Private, Max-Age=60'
        };
        const app = new App();
        for (const [name, value] of Object.entries(policies))
        {
            app.get(`/${ name }`, () => json({}, { headers: { 'cache-control': value } }));
        }
        app.get('/expires', () => json({}, { headers: { expires: 'Thu, 01 Jan 2099 00:00:00 GMT' } }));
        app.get('/unstated', () => json({}));
        // A CDN obeys its own field over Cache-Control (RFC 9213, Surrogate-Control).
        const targeted: Record<string, Record<string, string>> = {
            cdn: { 'cdn-cache-control': 'max-age=600' },
            cdnOverPrivate: { 'cache-control': 'private', 'cdn-cache-control': 'max-age=600' },
            vendor: { 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'max-age=600' },
            surrogate: { 'surrogate-control': 'max-age=600' },
            akamai: { 'cache-control': 'private', 'akamai-cache-control': 'max-age=600' },
            edgeControl: { 'cache-control': 'private', 'edge-control': '!no-store, cache-maxage=600s' },
            cdnNoStore: { 'cdn-cache-control': 'no-store' },
            cdnPrivate: { 'cache-control': 'private', 'cdn-cache-control': 'private' },
            akamaiNoStore: { 'cache-control': 'private', 'akamai-cache-control': 'no-store' }
        };
        for (const [name, headers] of Object.entries(targeted))
        {
            app.get(`/${ name }`, () => json({}, { headers }));
        }
        const handler = pipeline(app, csrfCookie({ secure: false }));

        const seen: Record<string, string> = {};
        for (const name of [...Object.keys(policies), 'expires', 'unstated', ...Object.keys(targeted)])
        {
            const response = await handler.handle(new Request(`http://local/${ name }`));
            seen[name] = `${ minted(response) ? 'minted' : 'none' } ${ response.headers.get('cache-control') }`;
        }
        expect(seen).toEqual({
            isr: 'none public, max-age=0, must-revalidate',
            asset: 'none public, max-age=31536000, immutable',
            maxAge: 'none max-age=60',
            noCache: 'none no-cache',
            sMaxage: 'none s-maxage=60',
            qualifiedPrivate: 'none private="set-cookie", max-age=60',
            private: 'minted private',
            noStore: 'minted no-store',
            mixedCase: 'minted Private, Max-Age=60',
            expires: 'none null',
            unstated: 'minted private',
            cdn: 'none null',
            cdnOverPrivate: 'none private',
            vendor: 'none no-store',
            surrogate: 'none null',
            akamai: 'none private',
            edgeControl: 'none private',
            cdnNoStore: 'minted private',
            cdnPrivate: 'minted private',
            akamaiNoStore: 'minted private'
        });
    });

    it('drops its own cookie from an answer that already carries one when a layer inside made it shared, and keeps the rest', async () =>
    {
        // The kit mints before the render, then a layer inside csrfCookie shares the page.
        const app = new App();
        const cookies = ['azcsrf=KIT-minted-for-the-render-0123456789; Path=/', 'session=s1; Path=/; HttpOnly'];
        app.get('/shared', () => new Response('page', { headers: [...cookies.map((line): [string, string] => ['set-cookie', line]), ['cdn-cache-control', 'max-age=60']] }));
        const handler = pipeline(app, csrfCookie({ secure: false }));
        const response = await handler.handle(new Request('http://local/shared'));
        expect(response.headers.getSetCookie()).toEqual(['session=s1; Path=/; HttpOnly']);
        expect(await response.text()).toBe('page');
    });

    it('CONTROL: an answer that already carries its own cookie and stays private passes untouched', async () =>
    {
        const app = new App();
        const cookies = ['azcsrf=KIT-minted-for-the-render-0123456789; Path=/', 'session=s1; Path=/; HttpOnly'];
        app.get('/private', () => new Response('page', { headers: [...cookies.map((line): [string, string] => ['set-cookie', line]), ['cache-control', 'private']] }));
        const handler = pipeline(app, csrfCookie({ secure: false }));
        const response = await handler.handle(new Request('http://local/private'));
        expect(response.headers.getSetCookie()).toEqual(cookies);
        expect(response.headers.get('cache-control')).toBe('private');
    });

    it('answers /__azeroth/csrf with 204 private, no-store and the cookie, under any prefix', async () =>
    {
        // The app's own catch-all is public, so only the endpoint can hand the cookie out here.
        const app = new App();
        app.get('/*path', () => json({ reached: 'app' }, { headers: { 'cache-control': 'public, max-age=60' } }));
        const handler = pipeline(app, csrfCookie({ secure: false }));
        for (const path of ['/__azeroth/csrf', '/api/__azeroth/csrf'])
        {
            const response = await handler.handle(new Request(`http://local${ path }`));
            expect(response.status, path).toBe(204);
            expect(response.headers.get('cache-control'), path).toBe('private, no-store');
            expect(minted(response), path).toBe(true);
            expect(await response.text(), path).toBe('');
        }
        // A holder gets no new token: its own is set again beside the name, and none elsewhere.
        const holder = await handler.handle(new Request('http://local/__azeroth/csrf', { headers: { cookie: `azcsrf=${ TOKEN }` } }));
        expect(holder.status).toBe(204);
        expect(holder.headers.getSetCookie().map((line) => line.split(';')[0])).toEqual([`azcsrf=${ TOKEN }`]);
        const sibling = await handler.handle(new Request('http://local/__azeroth/csrf', { headers: { cookie: `azcsrf=${ TOKEN }`, 'sec-fetch-site': 'same-site' } }));
        expect(sibling.headers.getSetCookie()).toEqual([]);
        // Only a GET: any other method is the app's.
        const posted = await handler.handle(new Request('http://local/__azeroth/csrf', { method: 'POST' }));
        expect(posted.status).toBe(405);
    });

    it('answers the endpoint the same under app.use, and a renamed cookie is minted under its own name', async () =>
    {
        const app = new App();
        app.use(csrfCookie({ secure: false, cookie: 'app-csrf' }));
        app.get('/*path', () => json({ reached: 'app' }, { headers: { 'cache-control': 'public, max-age=60' } }));
        const response = await app.handle(new Request('http://local/app/__azeroth/csrf'));
        expect(response.status).toBe(204);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.getSetCookie().map((line) => line.split('=')[0])).toEqual(['app-csrf']);
    });

    it('names the cookie it compares and its token to the page\'s own script, minted or already held', async () =>
    {
        const own = { 'sec-fetch-site': 'same-origin' };
        const handler = pipeline(new App(), csrfCookie({}));
        const fresh = await handler.handle(new Request('https://local/__azeroth/csrf', { headers: own }));
        expect(fresh.headers.get('x-azeroth-csrf-cookie')).toBe(fresh.headers.getSetCookie()[0]?.split(';')[0]);
        expect(fresh.headers.get('x-azeroth-csrf-cookie')).toMatch(/^__Host-azcsrf=[\w-]{43}$/);
        const held = await handler.handle(new Request('https://local/__azeroth/csrf', { headers: { ...own, cookie: `azcsrf=PLANTED-by-a-sibling-0123456789; __Host-azcsrf=${ TOKEN }` } }));
        // Named only beside its own Set-Cookie: a cache that keeps no such answer keeps no token.
        expect(held.headers.getSetCookie().map((line) => line.split(';')[0])).toEqual([`__Host-azcsrf=${ TOKEN }`]);
        expect(held.headers.get('x-azeroth-csrf-cookie')).toBe(`__Host-azcsrf=${ TOKEN }`);
        // The name a secure: false server reads, beside a __Host- cookie a secure run left.
        const dev = await pipeline(new App(), csrfCookie({ secure: false })).handle(
            new Request('http://local/__azeroth/csrf', { headers: { ...own, cookie: `__Host-azcsrf=STALE-left-by-a-secure-run-0123; azcsrf=${ TOKEN }` } }));
        expect(dev.headers.get('x-azeroth-csrf-cookie')).toBe(`azcsrf=${ TOKEN }`);
        expect(held.headers.get('cache-control')).toBe('private, no-store');
    });

    it('names no pair for a held value not made only of letters, digits, - and _, and still answers 204', async () =>
    {
        const handler = pipeline(new App(), csrfCookie({}));
        const loosened = ['.', '~', '!', '/', '+', '='].map((char) => `AAAAAAAAAAAAAAAAAAAA${ char }`);
        for (const value of ['%0D%0AX-Evil:%201AAAAAAAAAAAAAAAA', '%E2%80%A6AAAAAAAAAAAAAAAAAAAA', '%00AAAAAAAAAAAAAAAAAAAAAA', ...loosened])
        {
            const response = await handler.handle(new Request('https://local/__azeroth/csrf', { headers: { 'sec-fetch-site': 'same-origin', cookie: `__Host-azcsrf=${ value }` } }));
            expect(response.status, value).toBe(204);
            expect(response.headers.get('x-azeroth-csrf-cookie'), value).toBeNull();
            expect(response.headers.getSetCookie(), value).toEqual([]);
        }
    });

    // A sibling's Domain or longer-Path cookie rides first; set again, it replaces the visitor's.
    it('names nothing and sets nothing for a name the request holds with two values', async () =>
    {
        const handler = pipeline(new App(), csrfCookie({ secure: false }));
        const ask = (cookie: string): Promise<Response> => handler.handle(new Request('http://local/__azeroth/csrf', { headers: { 'sec-fetch-site': 'same-origin', cookie } }));
        const two = await ask(`azcsrf=PLANTED-by-a-sibling-0123456789; azcsrf=${ TOKEN }`);
        expect(two.status).toBe(204);
        expect(two.headers.get('x-azeroth-csrf-cookie')).toBeNull();
        expect(two.headers.getSetCookie()).toEqual([]);
        // CONTROL: the same value twice is one token, named and set again.
        const same = await ask(`azcsrf=${ TOKEN }; azcsrf=${ TOKEN }`);
        expect(same.headers.get('x-azeroth-csrf-cookie')).toBe(`azcsrf=${ TOKEN }`);
        expect(same.headers.getSetCookie().map((line) => line.split(';')[0])).toEqual([`azcsrf=${ TOKEN }`]);
    });

    it('names nothing to another site or origin, nor to a request with no Sec-Fetch-Site over https or loopback', async () =>
    {
        const handler = pipeline(new App(), csrfCookie({}));
        const ask = async (at: string, headers: Record<string, string>): Promise<string | null> =>
            (await handler.handle(new Request(`${ at }/__azeroth/csrf`, { headers: { cookie: `__Host-azcsrf=${ TOKEN }`, ...headers } })))
                .headers.get('x-azeroth-csrf-cookie');
        // Browsers send Sec-Fetch-Site to these, so a request without it is no page of this origin.
        for (const at of ['https://app.site.test', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost:3000'])
        {
            for (const headers of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'none' }, { origin: 'https://evil.site.test' }, { 'sec-fetch-site': 'same-origin', origin: 'https://evil.site.test' }, {}, { origin: at }])
            {
                expect(await ask(at, headers), `${ at } ${ JSON.stringify(headers) }`).toBeNull();
            }
            // CONTROL: the page's own script, with and without its own Origin.
            for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'same-origin', origin: at }])
            {
                expect(await ask(at, headers), `${ at } ${ JSON.stringify(headers) }`).toBe(`__Host-azcsrf=${ TOKEN }`);
            }
        }
        // Over plain http elsewhere browsers send none, so no fetch metadata still names the pair.
        const plain = 'http://app.site.test';
        for (const headers of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'http://evil.site.test' }])
        {
            expect(await ask(plain, headers), JSON.stringify(headers)).toBeNull();
        }
        for (const headers of [{ 'sec-fetch-site': 'same-origin' }, {}, { origin: plain }])
        {
            expect(await ask(plain, headers), JSON.stringify(headers)).toBe(`__Host-azcsrf=${ TOKEN }`);
        }
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
