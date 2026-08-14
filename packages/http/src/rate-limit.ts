/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Request rate limiting at the edge.
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

/** One key's fixed-window counter. */
interface RateBucket
{
    count: number;

    resetAt: number;

    limit: number;
}

/**
 * A fixed-window counter in a Map. Buckets expire at their window end; a lazy sweep (once
 * per window, at most once a minute) drops expired keys, and a hard entry cap (default
 * 100000) bounds memory even against a deliberate churn of distinct keys.
 *
 * Eviction NEVER drops a bucket that is currently over its limit, because dropping one is
 * indistinguishable from forgiving it: an attacker who can mint keys (a forged
 * `X-Forwarded-For`, an IPv6 /64) would otherwise burn their allowance, churn the cap, and
 * return with a clean counter. Only under-limit or already-expired buckets are given up, and
 * when the store holds nothing but limited buckets it fails CLOSED - the new key is refused
 * rather than paid for with someone else's enforcement - and reports the state through
 * `onSaturation` so an operator can tell a key-space attack from ordinary limiting.
 *
 * Buckets are split across two maps by that standing, so admission never walks the store:
 * the evictable set is read from the front of one map in O(1) however deep the enforced
 * limits run, and worst-case work per hit is a constant independent of `maxEntries`.
 *
 * Single-process only - share one across a fleet and each node limits independently.
 */
export class MemoryRateStore implements RateStore
{
    /** Buckets at or under their limit: free to drop, least-recently-hit first. */
    readonly #spare = new Map<string, RateBucket>();

    /** Buckets over their limit: retained until their window ends, least-recently-hit first. */
    readonly #enforced = new Map<string, RateBucket>();

    readonly #maxEntries: number;

    readonly #onSaturation: ((size: number) => void) | undefined;

    #nextSweep = 0;

    /** True once the running saturation episode has been announced, so refusals do not repeat it. */
    #saturationReported = false;

    /** Enforced buckets examined per admission while hunting an expired one. */
    static readonly #EVICT_SCAN = 8;

    /**
     * @param options.maxEntries - Hard cap on retained buckets (default 100000).
     * @param options.onSaturation - Called with the store's size when every retained bucket is
     * an enforced limit and a new key is refused; fired once per saturation episode, not per
     * refusal, and its own throws are swallowed.
     */
    constructor(options: { maxEntries?: number; onSaturation?: (size: number) => void } = {})
    {
        this.#maxEntries = options.maxEntries ?? 100_000;
        this.#onSaturation = options.onSaturation;
    }

    /** How many buckets are currently held (expired ones included until the next sweep). */
    public get size(): number
    {
        return this.#spare.size + this.#enforced.size;
    }

    public hit(key: string, limit: number, windowMs: number): RateLimitDecision
    {
        const now = Date.now();
        this.#sweep(now, windowMs);

        let bucket = this.#spare.get(key) ?? this.#enforced.get(key);
        if (bucket === undefined || bucket.resetAt <= now)
        {
            if (bucket === undefined && this.size >= this.#maxEntries && !this.#evict(now))
            {
                // Nothing was safe to drop: admitting this key would cost an enforced limit.
                // Refusing is the only direction that cannot be used to clear one.
                return { limited: true, limit, remaining: 0, resetSeconds: Math.ceil(windowMs / 1000) };
            }
            bucket = { count: 0, resetAt: now + windowMs, limit };
        }
        bucket.count += 1;
        // The caller owns the limit and may change it between hits; the bucket carries the
        // latest so #evict can tell an enforced bucket from a spare one.
        bucket.limit = limit;
        // Re-filed on EVERY hit, under its current standing and at the back of that map, so
        // iteration order is least-recently-hit first - which is where #evict starts. `Map.set`
        // on a key already present does not move it, so a continuously-active client stayed
        // pinned at the front, the first candidate.
        this.#spare.delete(key);
        this.#enforced.delete(key);
        if (bucket.count > limit)
        {
            this.#enforced.set(key, bucket);
        }
        else
        {
            this.#spare.set(key, bucket);
            // A spare bucket exists again (a window reset, a raised limit, a new key), so the
            // saturation episode is over and the next one is worth announcing.
            this.#saturationReported = false;
        }

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
        MemoryRateStore.#dropExpired(this.#spare, now);
        MemoryRateStore.#dropExpired(this.#enforced, now);
    }

    /** @internal Deletes every bucket in `buckets` whose window has already ended. */
    static #dropExpired(buckets: Map<string, RateBucket>, now: number): void
    {
        for (const [key, bucket] of buckets)
        {
            if (bucket.resetAt <= now)
            {
                buckets.delete(key);
            }
        }
    }

    /**
     * @internal Frees one slot. The least-recently-hit spare bucket goes first and is found
     * without a scan - losing an under-limit bucket costs nothing that was being enforced, and
     * because standing is filed at write time it is reachable however many enforced limits sit
     * in front of it. An empty spare map is itself the proof that every retained bucket is over
     * its limit; the only slot still free to take is then an enforced bucket whose window has
     * already ended, and at most {@link MemoryRateStore.#EVICT_SCAN} candidates are examined
     * per call, each rotated to the back so successive refusals advance through the map instead
     * of re-paying for the same front. Worst-case work per call is therefore a constant,
     * independent of the entry cap. Returning false tells the caller to fail closed, and the
     * saturation observer hears it once per episode.
     */
    #evict(now: number): boolean
    {
        const spare = this.#spare.keys().next();
        if (spare.done !== true)
        {
            this.#spare.delete(spare.value);
            return true;
        }
        // Bounded by the map's own size as well: rotation re-appends behind the live iterator,
        // which would otherwise hand back a bucket this call has already stepped over.
        let budget = Math.min(this.#enforced.size, MemoryRateStore.#EVICT_SCAN);
        for (const [key, bucket] of this.#enforced)
        {
            if (bucket.resetAt <= now)
            {
                this.#enforced.delete(key);
                return true;
            }
            // Rotated to the back: never dropped, but no longer in front of the next scan.
            this.#enforced.delete(key);
            this.#enforced.set(key, bucket);
            budget -= 1;
            if (budget === 0)
            {
                break;
            }
        }
        if (this.#saturationReported)
        {
            return false;
        }
        this.#saturationReported = true;
        if (this.#onSaturation !== undefined)
        {
            try
            {
                this.#onSaturation(this.size);
            }
            catch
            {
                // An observer must never be able to break the hit path.
            }
        }
        return false;
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
