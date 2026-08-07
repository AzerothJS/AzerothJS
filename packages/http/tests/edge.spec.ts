// @vitest-environment node
//
// The edge layer: cross-cutting concerns that wrap the whole app (request id, security
// headers, CORS, rate limiting) and the clientIp helper they build on. Every case runs
// through `app.handle(new Request(...))` composed under `pipeline` - no socket required.

import { describe, it, expect, vi } from 'vitest';
import {
    App, pipeline, requestId, requestIdOf, securityHeaders, cors, clientIp,
    rateLimit, MemoryRateStore, text, type WebHandler, type RateStore
} from '@azerothjs/http';
import { ipBucket } from '../src/client-ip.ts';

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
        app.get('/', ({ request }) =>
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

    it('emits HSTS over TLS or a trusted forwarded-proto claim, never on the client word alone', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, securityHeaders({ hsts: { maxAgeSeconds: 100 } }));

        const plain = await handler.handle(new Request('http://local/'));
        expect(plain.headers.get('strict-transport-security')).toBeNull();

        // x-forwarded-proto is client-forgeable: without trustProxy it proves nothing.
        const forged = await handler.handle(new Request('http://local/', { headers: { 'x-forwarded-proto': 'https' } }));
        expect(forged.headers.get('strict-transport-security')).toBeNull();

        const trusted = pipeline(app, securityHeaders({ hsts: { maxAgeSeconds: 100 }, trustProxy: true }));
        const secure = await trusted.handle(new Request('http://local/', { headers: { 'x-forwarded-proto': 'https' } }));
        expect(secure.headers.get('strict-transport-security')).toBe('max-age=100; includeSubDomains');
    });

    it('yields a default to a header the handler already set, while an explicit option still wins', async () =>
    {
        const app = new App();
        app.get('/page', () => new Response('x', { headers: { 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'cross-origin' } }));

        const kept = await pipeline(app, securityHeaders()).handle(new Request('http://local/page'));
        expect(kept.headers.get('x-frame-options')).toBe('DENY');                      // the stricter per-route choice survives
        expect(kept.headers.get('cross-origin-resource-policy')).toBe('cross-origin'); // the cross-origin font/CDN case survives
        expect(kept.headers.get('x-content-type-options')).toBe('nosniff');            // absent headers still get the baseline

        const overridden = await pipeline(app, securityHeaders({ frameOptions: 'SAMEORIGIN' })).handle(new Request('http://local/page'));
        expect(overridden.headers.get('x-frame-options')).toBe('SAMEORIGIN');          // a value the caller wrote is policy
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
        expect(response.headers.get('access-control-allow-headers')).toBe('Accept, Accept-Language, Content-Language, Content-Type');
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

    it('refuses origin true with credentials at wiring time', () =>
    {
        // Reflecting every origin with credentials attached is strictly worse than the
        // `*` the spec forbids: browsers honour the reflection. Refuse the combination.
        expect(() => cors({ origin: true, credentials: true })).toThrow(/credentials/);
    });

    it('treats a throwing origin predicate as a denial, not a rejection', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin: (origin) => new URL(origin).hostname.endsWith('.example.com') }));

        // Browsers send the literal `Origin: null` for sandboxed frames; new URL('null') throws.
        const denied = await handler.handle(new Request('http://local/', { headers: { origin: 'null' } }));
        expect(denied.status).toBe(200);
        expect(denied.headers.get('access-control-allow-origin')).toBeNull();

        const allowed = await handler.handle(new Request('http://local/', { headers: { origin: 'https://app.example.com' } }));
        expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    });

    it('never lets a predicate allow the null origin when credentials are on', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, cors({ origin: () => true, credentials: true }));
        const response = await handler.handle(new Request('http://local/', { headers: { origin: 'null' } }));
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('approves only the safelisted headers by default; an explicit list widens', async () =>
    {
        const handler = corsApp();
        const probing = await handler.handle(new Request('http://local/data', {
            method: 'OPTIONS',
            headers: { origin: 'https://good.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, x-csrf-token' }
        }));
        expect(probing.headers.get('access-control-allow-headers')).not.toContain('authorization');

        const app = new App();
        app.post('/data', () => text('ok'));
        const widened = pipeline(app, cors({ origin: true, allowedHeaders: ['Authorization'] }));
        const response = await widened.handle(new Request('http://local/data', {
            method: 'OPTIONS',
            headers: { origin: 'https://any.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' }
        }));
        expect(response.headers.get('access-control-allow-headers')).toBe('Authorization');
    });

    it('meters preflights through an inner rate limiter instead of short-circuiting past it', async () =>
    {
        const app = new App();
        app.post('/data', () => text('ok'));
        const handler = pipeline(app, cors({ origin: true }), rateLimit({ limit: 2, windowMs: 60_000, key: () => 'fixed' }));
        const preflight = (): Promise<Response> => handler.handle(new Request('http://local/data', {
            method: 'OPTIONS',
            headers: { origin: 'https://any.example', 'access-control-request-method': 'POST' }
        }));

        const first = await preflight();
        expect(first.status).toBe(204);
        expect(first.headers.get('ratelimit-remaining')).toBe('1'); // the budget was charged and reported

        await preflight();
        const third = await preflight();
        expect(third.status).toBe(429); // the limiter's refusal survives the preflight path
    });

    it('appends Vary: Origin even when the request carries no Origin', async () =>
    {
        const handler = corsApp();
        const response = await handler.handle(new Request('http://local/data'));
        expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin');
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

    it('fails closed when the store throws instead of rejecting through the pipeline', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const broken: RateStore =
        {
            hit: () =>
            {
                throw new Error('redis down');
            }
        };
        const handler = pipeline(app, rateLimit({ limit: 2, windowMs: 60_000, store: broken, key: () => 'fixed' }));

        const response = await handler.handle(new Request('http://local/'));
        expect(response.status).toBe(429); // an outage throttles; it neither crashes nor opens an unmetered lane
    });

    it('a throwing key derivation resolves to a response, never a rejection', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, rateLimit({ limit: 2, windowMs: 60_000, key: (request) => new URL(request.headers.get('origin') ?? 'none').host }));

        const response = await handler.handle(new Request('http://local/'));
        expect(response.status).toBe(429);
    });

    it('refuses loudly when no client identity exists instead of sharing one silent bucket', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, rateLimit({ limit: 2, windowMs: 60_000 }));

        // No socket capability and no key function (a fetch runtime): every request on earth
        // would share one bucket, which is the limiter silently disabled.
        const response = await handler.handle(new Request('http://local/'));
        expect(response.status).toBe(500);
        const body = await response.json() as { error: { code: string } };
        expect(body.error.code).toBe('rate-limit-key-unavailable');
    });

    it('keys on the trustedHops-selected forwarded entry so a multi-proxy chain shares no bucket', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, rateLimit({ limit: 1, windowMs: 60_000, trustProxy: true, trustedHops: 2 }));
        const viaProxy = (chain: string): Request => requestFromPeer('http://local/', '10.0.0.1', { headers: { 'x-forwarded-for': chain } });

        expect((await handler.handle(viaProxy('203.0.113.7, 10.0.0.2'))).status).toBe(200);
        // The same real client through a different inner proxy is the same bucket.
        expect((await handler.handle(viaProxy('203.0.113.7, 10.0.0.9'))).status).toBe(429);
        // A different real client is its own bucket.
        expect((await handler.handle(viaProxy('198.51.100.4, 10.0.0.2'))).status).toBe(200);
    });

    it('buckets IPv6 on its routed /64 so one allocation cannot mint fresh buckets per address', async () =>
    {
        const app = new App();
        app.get('/', () => text('ok'));
        const handler = pipeline(app, rateLimit({ limit: 1, windowMs: 60_000 }));

        expect((await handler.handle(requestFromPeer('http://local/', '2001:db8:aaaa:bbbb::1'))).status).toBe(200);
        expect((await handler.handle(requestFromPeer('http://local/', '2001:db8:aaaa:bbbb:dead:beef:1:2'))).status).toBe(429);
        expect((await handler.handle(requestFromPeer('http://local/', '2001:db8:aaaa:cccc::1'))).status).toBe(200);
    });
});

describe('MemoryRateStore', () =>
{
    it('sweeps on the window interval, not a hard minute, so short windows stay bounded', () =>
    {
        vi.useFakeTimers();
        try
        {
            const store = new MemoryRateStore();
            store.hit('a', 1, 10);
            vi.advanceTimersByTime(25);
            store.hit('b', 1, 10); // this hit's sweep must have dropped the expired 'a'
            expect(store.size).toBe(1);
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    it('caps the bucket map, evicting the oldest key', () =>
    {
        const store = new MemoryRateStore({ maxEntries: 3 });
        store.hit('k1', 1, 60_000);
        store.hit('k2', 1, 60_000);
        store.hit('k3', 1, 60_000);
        store.hit('k4', 1, 60_000);
        expect(store.size).toBe(3);
        expect(store.hit('k1', 1, 60_000).limited).toBe(false); // k1 was evicted: a fresh bucket, not the old count
    });

    it('a limited client cannot clear its own counter by churning keys past the cap', () =>
    {
        // Eviction is indistinguishable from forgiveness, so an attacker who can mint keys
        // (a forged X-Forwarded-For, an IPv6 /64) could burn their allowance, spray the cap,
        // and come back clean. This is the WORST case for the store: the attacker goes idle
        // during the churn, so their bucket is the least-recently-hit - the very first
        // eviction candidate. It must be skipped for being over its limit.
        const store = new MemoryRateStore({ maxEntries: 8 });
        for (let i = 0; i < 3; i++)
        {
            store.hit('attacker', 2, 60_000);
        }
        expect(store.hit('attacker', 2, 60_000).limited).toBe(true);

        for (let i = 0; i < 40; i++)
        {
            store.hit(`churn-${ i }`, 2, 60_000);
        }

        expect(store.size).toBeLessThanOrEqual(8);
        expect(store.hit('attacker', 2, 60_000).limited).toBe(true);
    });

    it('fails CLOSED when every retained bucket is an enforced limit', () =>
    {
        // With nothing safe to drop, admitting a new key would have to cost someone's
        // enforcement. Refusing the newcomer is the only direction that cannot be used to
        // clear a limit - the newcomer is told it is limited rather than given a free pass.
        const store = new MemoryRateStore({ maxEntries: 4 });
        for (const key of ['a', 'b', 'c', 'd'])
        {
            store.hit(key, 1, 60_000);
            store.hit(key, 1, 60_000); // count 2 > limit 1: every bucket is over
        }
        expect(store.hit('newcomer', 1, 60_000).limited).toBe(true);
        // ...and none of the enforced buckets was traded away for it.
        for (const key of ['a', 'b', 'c', 'd'])
        {
            expect(store.hit(key, 1, 60_000).limited).toBe(true);
        }
    });
});

describe('ipBucket', () =>
{
    it('leaves IPv4 per-host and collapses the v4-mapped form onto it', () =>
    {
        expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
        expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    });

    it('truncates IPv6 to the /64 allocation by default, configurably', () =>
    {
        expect(ipBucket('2001:db8:1:2::1')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
        expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
        expect(ipBucket('2001:db8:1:2::1', 48)).toBe(ipBucket('2001:db8:1:3::1', 48));
    });

    it('caps the key length for unparseable garbage', () =>
    {
        expect(ipBucket(`:${ 'x'.repeat(300) }`).length).toBeLessThanOrEqual(64);
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
