// @vitest-environment node
//
// The edge layer: cross-cutting concerns that wrap the whole app (request id, security
// headers, CORS, rate limiting) and the clientIp helper they build on. Every case runs
// through `app.handle(new Request(...))` composed under `pipeline` - no socket required.

import { describe, it, expect } from 'vitest';
import {
    App, pipeline, requestId, requestIdOf, securityHeaders, cors, clientIp,
    rateLimit, MemoryRateStore, text, type WebHandler
} from '@azerothjs/http';

const SOCKET_ADDRESS = Symbol.for('azerothjs.http.socketAddress');

/** A request carrying a fake TCP peer address, as the Node adapter would expose it. */
function requestFromPeer(url: string, peer: string, init?: RequestInit): Request
{
    const request = new Request(url, init);
    (request as { [SOCKET_ADDRESS]?: () => string | null })[SOCKET_ADDRESS] = () => peer;
    return request;
}

describe('requestId', () =>
{
    it('mints a uuid when none is supplied and echoes it, exposing it to the handler', async () =>
    {
        let seen: string | undefined;
        const app = new App();
        app.get('/', (request) =>
        {
            seen = requestIdOf(request);
            return text('ok');
        });
        const handler = pipeline(app, requestId());

        const response = await handler.handle(new Request('http://local/'));
        const echoed = response.headers.get('x-request-id');
        expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
        expect(seen).toBe(echoed); // the handler saw the same id that came back on the wire
    });

    it('honors a well-formed inbound id but mints a fresh one for a malformed header', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, requestId());

        const honored = await handler.handle(new Request('http://local/', { headers: { 'x-request-id': 'trace-abc-123' } }));
        expect(honored.headers.get('x-request-id')).toBe('trace-abc-123');

        const rejected = await handler.handle(new Request('http://local/', { headers: { 'x-request-id': 'bad id with spaces' } }));
        expect(rejected.headers.get('x-request-id')).not.toBe('bad id with spaces');
        expect(rejected.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('securityHeaders', () =>
{
    it('sets safe defaults, honors overrides, and omits a header set to false', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, securityHeaders({ frameOptions: 'DENY', referrerPolicy: false }));

        const response = await handler.handle(new Request('http://local/'));
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-frame-options')).toBe('DENY');          // override wins
        expect(response.headers.get('referrer-policy')).toBeNull();            // false omits it
        expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    });

    it('emits HSTS only over a proven-secure connection', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, securityHeaders({ hsts: { maxAgeSeconds: 100 } }));

        const plain = await handler.handle(new Request('http://local/'));
        expect(plain.headers.get('strict-transport-security')).toBeNull();

        const secure = await handler.handle(new Request('http://local/', { headers: { 'x-forwarded-proto': 'https' } }));
        expect(secure.headers.get('strict-transport-security')).toBe('max-age=100; includeSubDomains');
    });
});

describe('cors', () =>
{
    function corsApp(): WebHandler
    {
        const app = new App();
        app.get('/data', () => new Response('x', { headers: { vary: 'Accept-Encoding' } }));
        app.post('/data', () => text('created'));
        return pipeline(app, cors({ origin: ['https://good.example'], credentials: true }));
    }

    it('answers a preflight with 204 and the negotiated headers, without running the route', async () =>
    {
        const handler = corsApp();
        const response = await handler.handle(new Request('http://local/data', {
            method: 'OPTIONS',
            headers: { origin: 'https://good.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
        }));
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-origin')).toBe('https://good.example');
        expect(response.headers.get('access-control-allow-methods')).toContain('POST');
        expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
        expect(response.headers.get('access-control-allow-credentials')).toBe('true');
        expect(await response.text()).toBe(''); // the POST handler never ran
    });

    it('decorates a real response and merges Vary instead of overwriting it', async () =>
    {
        const handler = corsApp();
        const response = await handler.handle(new Request('http://local/data', { headers: { origin: 'https://good.example' } }));
        expect(response.headers.get('access-control-allow-origin')).toBe('https://good.example');
        expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin');
        expect(await response.text()).toBe('x');
    });

    it('withholds the allow-origin header from a disallowed origin', async () =>
    {
        const handler = corsApp();
        const response = await handler.handle(new Request('http://local/data', { headers: { origin: 'https://evil.example' } }));
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(response.headers.get('vary')).toContain('Origin');
    });

    it('reflects a specific origin (never *) when credentials are enabled with origin true', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin: true, credentials: true }));
        const response = await handler.handle(new Request('http://local/', { headers: { origin: 'https://any.example' } }));
        expect(response.headers.get('access-control-allow-origin')).toBe('https://any.example');
    });
});

describe('clientIp', () =>
{
    it('returns the unspoofable peer and ignores a forwarded header without trustProxy', () =>
    {
        const request = requestFromPeer('http://local/', '203.0.113.9', { headers: { 'x-forwarded-for': '1.1.1.1' } });
        expect(clientIp(request)).toBe('203.0.113.9');
    });

    it('selects the correct forwarded entry by trustedHops when trusted', () =>
    {
        const request = requestFromPeer('http://local/', '10.0.0.1', { headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7' } });
        expect(clientIp(request, { trustProxy: true })).toBe('7.7.7.7');                 // one hop -> rightmost
        expect(clientIp(request, { trustProxy: true, trustedHops: 2 })).toBe('8.8.8.8'); // two hops -> one further left
    });

    it('falls back to the peer when the chain is shorter than the trust boundary', () =>
    {
        const request = requestFromPeer('http://local/', '10.0.0.1', { headers: { 'x-forwarded-for': '9.9.9.9' } });
        expect(clientIp(request, { trustProxy: true, trustedHops: 3 })).toBe('10.0.0.1');
    });

    it('is undefined off-socket with no trusted header', () =>
    {
        expect(clientIp(new Request('http://local/'))).toBeUndefined();
    });
});

describe('rateLimit', () =>
{
    it('allows up to the limit, then refuses with 429 + Retry-After and RateLimit headers', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const store = new MemoryRateStore();
        const handler = pipeline(app, rateLimit({ limit: 2, windowMs: 60_000, store, key: () => 'fixed' }));

        const first = await handler.handle(new Request('http://local/'));
        expect(first.status).toBe(200);
        expect(first.headers.get('ratelimit-remaining')).toBe('1');

        const second = await handler.handle(new Request('http://local/'));
        expect(second.status).toBe(200);
        expect(second.headers.get('ratelimit-remaining')).toBe('0');

        const third = await handler.handle(new Request('http://local/'));
        expect(third.status).toBe(429);
        expect(third.headers.get('retry-after')).not.toBeNull();
        expect(third.headers.get('ratelimit-remaining')).toBe('0');
        const body = await third.json() as { error: { code: string } };
        expect(body.error.code).toBe('too-many-requests');
    });
});

describe('pipeline', () =>
{
    it('composes multiple edge middleware around one app', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, requestId(), securityHeaders());

        const response = await handler.handle(new Request('http://local/'));
        expect(response.headers.get('x-request-id')).not.toBeNull();
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await response.text()).toBe('ok');
    });
});
