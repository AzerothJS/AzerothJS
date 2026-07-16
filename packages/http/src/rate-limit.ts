/**
 * MODULE: http/rate-limit - request rate limiting at the edge
 *
 * A fixed-window limiter over a small store interface. The default store is an in-memory Map
 * with lazy eviction - correct for a single process and the common case - and the RateStore
 * interface is the seam: back it with Redis for a fleet without touching a handler. The
 * limiter keys on the client IP by default (through the same trusted-proxy boundary as
 * `clientIp`), throws the kernel's TooManyRequestsError with Retry-After when the window is
 * exhausted, and stamps the standard RateLimit-* headers on every response so a well-behaved
 * client can pace itself before it is ever refused.
 */

import type { EdgeMiddleware } from './edge.ts';
import { withResponseHeaders } from './edge.ts';
import { errorResponse, TooManyRequestsError } from './errors.ts';
import { clientIp } from './client-ip.ts';

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
 * A fixed-window counter in a Map. Buckets expire at their window end; a lazy sweep (at most
 * once a minute) drops expired keys so a churn of distinct clients cannot grow the map without
 * bound. Single-process only - share one across a fleet and each node limits independently.
 */
export class MemoryRateStore implements RateStore
{
    readonly #buckets = new Map<string, { count: number; resetAt: number }>();

    #nextSweep = 0;

    public hit(key: string, limit: number, windowMs: number): RateLimitDecision
    {
        const now = Date.now();
        this.#sweep(now);

        let bucket = this.#buckets.get(key);
        if (bucket === undefined || bucket.resetAt <= now)
        {
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

    /** @internal Drops expired buckets, at most once a minute, so the map stays bounded. */
    #sweep(now: number): void
    {
        if (now < this.#nextSweep)
        {
            return;
        }
        this.#nextSweep = now + 60_000;
        for (const [key, bucket] of this.#buckets)
        {
            if (bucket.resetAt <= now)
            {
                this.#buckets.delete(key);
            }
        }
    }
}

export interface RateLimitOptions
{
    /** Maximum requests allowed per key per window. */
    limit: number;

    /** Window length in milliseconds. */
    windowMs: number;

    /** The counter store (default a fresh {@link MemoryRateStore}). */
    store?: RateStore;

    /** Derives the bucket key from a request (default the client IP, or `unknown` off-socket). */
    key?: (request: Request) => string;

    /** When keying on IP by default, trust the forwarding header (default false). See {@link clientIp}. */
    trustProxy?: boolean;
}

/**
 * Rate limiting. Counts each request against its key; once a key exceeds `limit` within
 * `windowMs`, further requests are refused with 429 + Retry-After until the window resets.
 * Every response carries RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset.
 */
export function rateLimit(options: RateLimitOptions): EdgeMiddleware
{
    const store = options.store ?? new MemoryRateStore();
    const keyOf = options.key
        ?? ((request: Request): string => clientIp(request, { trustProxy: options.trustProxy === true }) ?? 'unknown');

    return (next) => ({
        async handle(request: Request): Promise<Response>
        {
            const decision = await store.hit(keyOf(request), options.limit, options.windowMs);
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
    });
}
