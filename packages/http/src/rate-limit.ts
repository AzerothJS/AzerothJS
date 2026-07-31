/**
 * MODULE: http/rate-limit - request rate limiting at the edge
 *
 * A fixed-window limiter over a small store interface. The default store is an in-memory Map
 * with lazy eviction - correct for a single process and the common case - and the RateStore
 * interface is the seam: back it with Redis for a fleet without touching a handler. The
 * limiter keys on the client IP by default (through the same trusted-proxy boundary as
 * `clientIp`, with IPv6 bucketed on its routed prefix via `ipBucket`), throws the kernel's
 * TooManyRequestsError with Retry-After when the window is exhausted, and stamps the standard
 * RateLimit-* headers on every response so a well-behaved client can pace itself before it is
 * ever refused.
 */

import { withResponseHeaders, edge, type EdgeMiddleware } from './edge.ts';
import { errorResponse, HttpError, TooManyRequestsError } from './errors.ts';
import { clientIp, ipBucket } from './client-ip.ts';

/** The outcome of counting one request against a key. */
export interface RateLimitDecision
{
    /** True when this request pushed the key OVER its limit and must be refused. */
    limited: boolean;

    /** The configured ceiling for the window. */
    limit: number;

    /** Requests still allowed in the current window (0 once limited). */
    remaining: number;

    /** Seconds until the current window resets. */
    resetSeconds: number;
}

/** The storage seam. The default is in-memory; a Redis-backed implementation is a drop-in. */
export interface RateStore
{
    /** Counts one hit against `key` and reports the resulting decision. */
    hit(key: string, limit: number, windowMs: number): RateLimitDecision | Promise<RateLimitDecision>;
}

/**
 * A fixed-window counter in a Map. Buckets expire at their window end; a lazy sweep (once
 * per window, at most once a minute) drops expired keys, and a hard entry cap (default
 * 100000, oldest bucket evicted) bounds memory even against a deliberate churn of distinct
 * keys. Single-process only - share one across a fleet and each node limits independently.
 */
export class MemoryRateStore implements RateStore
{
    readonly #buckets = new Map<string, { count: number; resetAt: number }>();

    readonly #maxEntries: number;

    #nextSweep = 0;

    constructor(options: { maxEntries?: number } = {})
    {
        this.#maxEntries = options.maxEntries ?? 100_000;
    }

    /** How many buckets are currently held (expired ones included until the next sweep). */
    public get size(): number
    {
        return this.#buckets.size;
    }

    public hit(key: string, limit: number, windowMs: number): RateLimitDecision
    {
        const now = Date.now();
        this.#sweep(now, windowMs);

        let bucket = this.#buckets.get(key);
        if (bucket === undefined || bucket.resetAt <= now)
        {
            if (bucket === undefined && this.#buckets.size >= this.#maxEntries)
            {
                this.#evict();
            }
            bucket = { count: 0, resetAt: now + windowMs };
            this.#buckets.set(key, bucket);
        }
        bucket.count += 1;

        return {
            limited: bucket.count > limit,
            limit,
            remaining: Math.max(0, limit - bucket.count),
            resetSeconds: Math.max(0, Math.ceil((bucket.resetAt - now) / 1000))
        };
    }

    /** @internal Drops expired buckets, once per window at most once a minute, so short windows
     * cannot strand a minute's worth of dead buckets. */
    #sweep(now: number, windowMs: number): void
    {
        if (now < this.#nextSweep)
        {
            return;
        }
        this.#nextSweep = now + Math.min(windowMs, 60_000);
        for (const [key, bucket] of this.#buckets)
        {
            if (bucket.resetAt <= now)
            {
                this.#buckets.delete(key);
            }
        }
    }

    /** @internal At capacity the oldest-inserted bucket goes - O(1), and under key churn the
     * oldest is the closest to expiry; refusing new keys instead would let an attacker lock
     * real clients out of the map. */
    #evict(): void
    {
        const oldest = this.#buckets.keys().next();
        if (!oldest.done)
        {
            this.#buckets.delete(oldest.value);
        }
    }
}

/**
 * Options for {@link rateLimit}: the window, the budget, the key (defaults to the client IP -
 * behind a proxy set `trustProxy`/`trustedHops` or every client shares the proxy's bucket),
 * and the store ({@link MemoryRateStore} by default; swap for shared state across instances).
 */
export interface RateLimitOptions
{
    /**
     * Maximum requests allowed per key per window. Fixed-window arithmetic: a full allowance
     * at the end of one window and another at the start of the next are both honored, so the
     * instantaneous ceiling across a window boundary is TWICE this value - size an OTP or
     * login limit accordingly.
     */
    limit: number;

    /** Window length in milliseconds. */
    windowMs: number;

    /** The counter store (default a fresh {@link MemoryRateStore}). */
    store?: RateStore;

    /** Derives the bucket key from a request (default the client IP; refused loudly off-socket). */
    key?: (request: Request) => string;

    /**
     * When keying on IP by default, trust the forwarding header (default false). Behind a
     * reverse proxy this MUST be on: left off, every client shares the proxy's address and
     * `limit` becomes one GLOBAL budget an attacker can exhaust for everyone. See
     * {@link clientIp}.
     */
    trustProxy?: boolean;

    /** How many proxies sit in front of this server, direct peer included (default 1). See {@link clientIp}. */
    trustedHops?: number;

    /** IPv6 prefix length the default key buckets on (default 64, the per-customer allocation). See {@link ipBucket}. */
    ipv6Prefix?: number;
}

/**
 * Rate limiting. Counts each request against its key; once a key exceeds `limit` within
 * `windowMs`, further requests are refused with 429 + Retry-After until the window resets.
 * Every response carries RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset. A throwing
 * key or store fails CLOSED (a refusal, never a rejection): request-derived input and a store
 * outage must not become an unmetered lane or a process kill.
 */
export function rateLimit(options: RateLimitOptions): EdgeMiddleware
{
    const store = options.store ?? new MemoryRateStore();
    const keyOf = options.key ?? ((request: Request): string =>
    {
        const ip = clientIp(request, options.trustedHops === undefined
            ? { trustProxy: options.trustProxy === true }
            : { trustProxy: options.trustProxy === true, trustedHops: options.trustedHops });
        if (ip === undefined)
        {
            // Without a client identity every request would share one silent global bucket,
            // which is the limiter disabled. Refuse loudly instead.
            throw new HttpError(500, 'rateLimit has no client identity to key on: this runtime exposes no socket address, so provide a `key` function.', { code: 'rate-limit-key-unavailable' });
        }
        return ipBucket(ip, options.ipv6Prefix);
    });

    return edge((next) => ({
        async handle(request: Request): Promise<Response>
        {
            let decision: RateLimitDecision;
            try
            {
                decision = await store.hit(keyOf(request), options.limit, options.windowMs);
            }
            catch (error)
            {
                if (error instanceof HttpError)
                {
                    return errorResponse(error);
                }
                decision = {
                    limited: true,
                    limit: options.limit,
                    remaining: 0,
                    resetSeconds: Math.max(1, Math.ceil(options.windowMs / 1000))
                };
            }
            const headers: Record<string, string> = {
                'ratelimit-limit': String(decision.limit),
                'ratelimit-remaining': String(decision.remaining),
                'ratelimit-reset': String(decision.resetSeconds)
            };

            if (decision.limited)
            {
                // Refuse WITHOUT running the app; Retry-After comes from the error itself.
                return withResponseHeaders(errorResponse(new TooManyRequestsError(decision.resetSeconds)), headers);
            }
            return withResponseHeaders(await next.handle(request), headers);
        }
    }));
}
