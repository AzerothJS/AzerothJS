// @vitest-environment node
//
// The kernel's guarantees stop at its own boundary, and these are the places where nothing
// outside re-established them: a client header that moved the routed path, a rejection that
// escaped to the process, an error path that could itself throw, and headers a test could see
// but the socket never carried.
//
// Node environment deliberately: happy-dom implements the fetch spec's FORBIDDEN HEADER NAMES,
// silently dropping `Origin` and `Accept-Encoding` from a constructed Request. A server test
// that needs to see those headers passes for the wrong reason there.
import { describe, expect, it } from 'vitest';

import { App, HttpError, json, pipeline, text, type RequestContext } from '@azerothjs/http';
import { RadixRouter } from '../src/router.ts';

describe('routed path is not client-controlled', () =>
{
    it('context.path is the path the router matched, not the spelling the client sent', async () =>
    {
        const app = new App({ dev: false });
        const seen: Array<{ path: string; pathname: string }> = [];
        app.get('/admin', (context: RequestContext) =>
        {
            seen.push({ path: context.path, pathname: context.url.pathname });
            return text('secret');
        });

        // Percent-decoding and one trailing slash ARE equivalence-preserving (RFC 3986 6.2.2.2,
        // and trailing-slash tolerance is deliberate policy), so these still reach the handler
        // spelled differently - which is what context.path exists to normalize.
        for (const spelling of ['/admin', '/%61dmin', '/admin/'])
        {
            const response = await app.handle(new Request(`http://x${ spelling }`));
            expect(response.status, spelling).toBe(200);
        }

        // An empty segment is NOT equivalence-preserving, so these never reach the handler at
        // all - see empty-segments.spec.ts. Refusing them beats normalizing them afterwards:
        // a guard on url.pathname is now safe even though it never learned about context.path.
        for (const spelling of ['//admin', '/admin//'])
        {
            const response = await app.handle(new Request(`http://x${ spelling }`));
            expect(response.status, spelling).toBe(404);
        }

        expect(seen.map((entry) => entry.path)).toEqual(['/admin', '/admin', '/admin']);
        expect(new Set(seen.map((entry) => entry.pathname)).size).toBeGreaterThan(1);
    });
});

describe('the composed edge handler keeps the kernel contract', () =>
{
    it('a throwing middleware becomes a 500 instead of a rejection', async () =>
    {
        const app = new App({ dev: false });
        app.get('/', () => json({ ok: true }));

        // What the idiomatic subdomain allowlist does when handed an unparseable Origin, and what
        // a rate-limit store does when its backend refuses a connection.
        const handler = pipeline(app, (next) => ({
            handle: async (request: Request): Promise<Response> =>
            {
                void new URL(request.headers.get('origin') ?? '').hostname;
                return next.handle(request);
            }
        }));

        // `Origin: null` is what a sandboxed iframe, a data: URL and a file:// page all send.
        const response = await handler.handle(new Request('http://x/', { headers: { origin: 'null' } }));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } });
    });
});

describe('the error path cannot itself throw', () =>
{
    it('an unserializable details payload still produces a response', async () =>
    {
        const app = new App({ dev: false });
        app.get('/bigint', () =>
        {
            throw new HttpError(400, 'bad row', { details: { id: 10n } });
        });
        app.get('/cycle', () =>
        {
            const cyclic: Record<string, unknown> = {};
            cyclic.self = cyclic;
            throw new HttpError(400, 'bad row', { details: cyclic });
        });
        app.get('/nonprimitive', () =>
        {
            throw Object.create(null);
        });

        for (const path of ['/bigint', '/cycle', '/nonprimitive'])
        {
            const response = await app.handle(new Request(`http://x${ path }`));
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(typeof await response.text()).toBe('string');
        }
    });

    it('a 5xx does not publish details, while a 4xx still does', async () =>
    {
        const app = new App({ dev: false });
        app.get('/internal', () =>
        {
            throw new HttpError(500, 'connect ECONNREFUSED', {
                details: { dsn: 'postgres://svc:hunter2@db/app', query: 'select token from sessions' }
            });
        });
        app.get('/invalid', () =>
        {
            throw new HttpError(422, 'invalid', { details: { fields: { name: 'required' } } });
        });

        const internal = await app.handle(new Request('http://x/internal'));
        const internalBody = await internal.text();
        expect(internalBody).not.toContain('hunter2');
        expect(internalBody).not.toContain('select token');

        // The 422 field map is the documented form contract and must survive.
        expect(await (await app.handle(new Request('http://x/invalid'))).json())
            .toEqual({ error: { code: 'unprocessable', message: 'invalid', details: { fields: { name: 'required' } } } });
    });

    it('an error header cannot clobber the framing it was merged into', async () =>
    {
        const app = new App({ dev: false });
        app.get('/', () =>
        {
            throw new HttpError(400, 'x', { headers: { 'content-length': '2' } });
        });

        const response = await app.handle(new Request('http://x/'));
        const body = await response.text();
        expect(response.headers.get('content-length')).toBe(String(new TextEncoder().encode(body).byteLength));
    });

    it('a CRLF in an error header is dropped rather than committed to the wire', async () =>
    {
        const app = new App({ dev: false });
        app.get('/', () =>
        {
            throw new HttpError(401, 'nope', { headers: { 'www-authenticate': 'Bearer realm="a\r\nX-Injected: 1"' } });
        });

        const response = await app.handle(new Request('http://x/'));
        expect(response.status).toBe(401);
        expect(response.headers.get('x-injected')).toBeNull();
    });
});

describe('a response header written the standard way reaches the wire', () =>
{
    it('mutating the headers view of a kernel response is visible in raw()', async () =>
    {
        const app = new App({ dev: false });
        app.get('/', () => json({ balance: 1 }));

        const response = await app.handle(new Request('http://x/'));
        response.headers.set('cache-control', 'no-store');
        response.headers.append('set-cookie', 'session=abc; HttpOnly');

        // raw() is what the node adapter writes; before the fix it read a stale record and the
        // header existed only in the view a test asserts on.
        const raw = (response as unknown as { raw(): { headers: Record<string, string | string[]> } }).raw();
        expect(raw.headers['cache-control']).toBe('no-store');
        expect(raw.headers['set-cookie']).toEqual(['session=abc; HttpOnly']);
    });
});

describe('middleware additions cannot forge the context', () =>
{
    it('a returned params/request/url is ignored', async () =>
    {
        const app = new App({ dev: false });
        let seen = '';
        // The shape that makes this reachable: a middleware returning parsed request data as its
        // additions, so a body of `{"params":{"id":"admin"}}` would replace the path params a
        // handler authorises on. Typed as adding nothing, which is what such a middleware claims.
        const forge = (): Record<never, never> => ({ params: { id: 'admin' }, url: null });

        app.use(forge).get('/users/:id', (context) =>
        {
            seen = context.params.id;
            return json({ id: context.params.id });
        });

        const response = await app.handle(new Request('http://x/users/7'));
        expect(response.status).toBe(200);
        expect(seen).toBe('7');
    });
});

describe('a bodyless status carries no body length', () =>
{
    it('json() at 204 declares no content-length', () =>
    {
        const response = json({ ignored: true }, { status: 204 });
        expect(response.status).toBe(204);
        expect(response.headers.get('content-length')).toBeNull();
    });
});

describe('a method mismatch is a backtracking dead end', () =>
{
    it('a static GET route does not shadow a param POST route', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/users/me', 'GET me');
        router.insert('POST', '/users/:id', 'POST :id');

        expect(router.match('POST', '/users/me')).toEqual({ kind: 'match', value: 'POST :id', params: { id: 'me' } });
        expect(router.match('GET', '/users/me')).toEqual({ kind: 'match', value: 'GET me', params: {} });
        // A verb nobody registered reports every method reachable at that path, across both the
        // static and the param branch, which the old single-terminal lookup could not see.
        expect(router.match('DELETE', '/users/me')).toEqual({ kind: 'method-mismatch', allowed: ['GET', 'HEAD', 'POST'] });
    });

    it('a static GET route does not shadow a wildcard POST route', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/files/a/b', 'GET exact');
        router.insert('POST', '/files/*rest', 'POST wild');

        expect(router.match('POST', '/files/a/b')).toEqual({ kind: 'match', value: 'POST wild', params: { rest: 'a/b' } });
    });
});

describe('the adapter fast lane cannot hang on a second read', () =>
{
    it('a second raw read rejects instead of waiting on an end event that never comes again', async () =>
    {
        const { createAdapterRequest } = await import('../src/adapter-request.ts');
        const { fastRawBody } = await import('../src/body.ts');
        const { Readable } = await import('node:stream');

        // The shape the Node adapter hands the kernel, after the body was already consumed.
        const incoming = Readable.from([Buffer.from('{"a":1}')]) as unknown as Parameters<typeof createAdapterRequest>[0];
        Object.assign(incoming, { method: 'POST', url: '/x', headers: { host: 'x', 'content-type': 'application/json' } });

        const request = createAdapterRequest(incoming, 'http', {});
        const lane = (request as unknown as Record<symbol, ((limit: number) => Promise<Uint8Array>) | undefined>)[fastRawBody];
        if (lane === undefined)
        {
            throw new Error('the adapter request no longer exposes the raw-body fast lane');
        }
        const fast = lane.bind(request);

        const first = await fast(1024);
        expect(new TextDecoder().decode(first)).toBe('{"a":1}');
        expect(request.bodyUsed).toBe(true);

        // Before the guard this waited on an 'end' the drained stream never emits again, wedging
        // the socket and its request root for the process lifetime.
        const second = await Promise.race([
            fast(1024).then(() => 'resolved').catch((error: unknown) => error),
            new Promise((resolve) => setTimeout(() => resolve('HUNG'), 250))
        ]);
        expect(second).toBeInstanceOf(TypeError);
    });
});

describe('a compressed variant revalidates without lying about its representation', () =>
{
    it('an encoding-suffixed ETag answers 304 only while the client still accepts that coding', async () =>
    {
        const { staticFiles } = await import('../src/static.ts');
        const { mkdtemp, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const root = await mkdtemp(join(tmpdir(), 'azeroth-etag-'));
        await writeFile(join(root, 'app.js'), 'console.log(1);'.repeat(40));

        const app = new App({ dev: false });
        app.get('/*path', staticFiles(root));

        const first = await app.handle(new Request('http://x/app.js', { headers: { 'accept-encoding': 'gzip' } }));
        expect(first.status).toBe(200);
        const identity = first.headers.get('etag') ?? '';
        const compressed = `${ identity.slice(0, -1) }-gzip"`;

        // A cache holding the gzip body, still asking for gzip: 304 is correct and saves the body.
        const revalidated = await app.handle(new Request('http://x/app.js', {
            headers: { 'if-none-match': compressed, 'accept-encoding': 'gzip' }
        }));
        expect(revalidated.status).toBe(304);

        // The same tag with no Accept-Encoding must NOT 304, or the cache serves gzip as identity.
        const identityAsked = await app.handle(new Request('http://x/app.js', {
            headers: { 'if-none-match': compressed }
        }));
        expect(identityAsked.status).toBe(200);

        // The plain case is untouched.
        expect((await app.handle(new Request('http://x/app.js', { headers: { 'if-none-match': identity } }))).status).toBe(304);
    });
});

describe('a route pattern that could never be reached is refused at registration', () =>
{
    it('a percent escape in a pattern throws instead of sitting dead in the table', () =>
    {
        const router = new RadixRouter<string>();
        expect(() => router.insert('GET', '/my%20page', 'dead')).toThrow(/percent escape/);
        // A bare `%` is genuinely reachable (a request for `/100%25` decodes to `100%`).
        expect(() => router.insert('GET', '/100%', 'live')).not.toThrow();
        expect(router.match('GET', '/100%25')).toEqual({ kind: 'match', value: 'live', params: {} });
    });
});

describe('a handler reason phrase reaches the wire', () =>
{
    it('statusText is written rather than replaced by the default phrase', async () =>
    {
        const { serve } = await import('../src/node.ts');
        const net = await import('node:net');

        const app = new App({ dev: false });
        app.get('/teapot', () => new Response('short', { status: 418, statusText: 'I am a teapot' }));
        const served = await serve(app, { port: 0 });

        const line = await new Promise<string>((resolve) =>
        {
            const socket = net.connect(served.port, '127.0.0.1', () =>
            {
                socket.write('GET /teapot HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
            });
            let buf = '';
            socket.on('data', (chunk) =>
            {
                buf += chunk.toString();
            });
            socket.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
        });

        await served.shutdown({ gracePeriodMs: 200 });
        expect(line).toBe('HTTP/1.1 418 I am a teapot');
    });
});
