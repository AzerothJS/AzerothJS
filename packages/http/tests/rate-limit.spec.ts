// @vitest-environment node
//
// MemoryRateStore admission under key-space saturation: a newcomer must reach an evictable
// bucket however deep the enforced limits run, the work that costs must stay bounded no matter
// how many buckets are retained, and a store that truly holds nothing else must fail closed and
// say so through onSaturation.

import { describe, it, expect, vi } from 'vitest';
import { App, MemoryRateStore, json, pipeline, rateLimit } from '@azerothjs/http';

const WINDOW = 60_000;

/**
 * The most Map operations one admission may cost. Any real value is a small constant; this is
 * loose enough to survive a change of eviction constant and tight enough that walking even a
 * few hundred buckets blows through it.
 */
const WORK_CEILING = 64;

/** Drives `key` over `limit` so its bucket is an enforced limit the store must retain. */
function enforce(store: MemoryRateStore, key: string, limit: number, windowMs = WINDOW): void
{
    for (let i = 0; i <= limit; i++)
    {
        store.hit(key, limit, windowMs);
    }
}

/** Fills `store` with `count` enforced buckets, least-recently-hit first. */
function saturate(store: MemoryRateStore, count: number): void
{
    for (let i = 0; i < count; i++)
    {
        enforce(store, `enforced-${ i }`, 1);
    }
}

/** A store filled to `maxEntries` with enforced limits and exactly one evictable bucket last. */
function saturatedWithOneSpare(maxEntries: number): MemoryRateStore
{
    const store = new MemoryRateStore({ maxEntries });
    saturate(store, maxEntries - 1);
    store.hit('spare', 1, WINDOW);
    return store;
}

type AnyMap = Map<unknown, unknown>;

type MapWalk = ReturnType<AnyMap[typeof Symbol.iterator]>;

/**
 * Counts the Map work `run` performs: every read, every move, and every entry an iteration
 * steps over. Nothing can walk the store without paying one of the three, so this is the size
 * of the scan an admission does - a bound that can be asserted outright, unlike a wall-clock
 * reading that varies with the machine.
 */
function mapWork(run: () => void): number
{
    let steps = 0;
    const read = vi.spyOn(Map.prototype, 'get');
    const write = vi.spyOn(Map.prototype, 'set');
    const drop = vi.spyOn(Map.prototype, 'delete');
    const walk = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: AnyMap): MapWalk
    {
        // `entries` walks identically and carries no spy, so the wrapper cannot recurse.
        const inner = this.entries();
        return {
            next(): IteratorResult<[unknown, unknown]>
            {
                steps += 1;
                return inner.next();
            }
        } as unknown as MapWalk;
    });

    try
    {
        run();
        // Counted before restoring: mockRestore clears the recorded calls.
        return steps + read.mock.calls.length + write.mock.calls.length + drop.mock.calls.length;
    }
    finally
    {
        read.mockRestore();
        write.mockRestore();
        drop.mockRestore();
        walk.mockRestore();
    }
}

describe('MemoryRateStore eviction under saturation', () =>
{
    it('admits a new key by reaching an evictable bucket behind a deep run of enforced ones', () =>
    {
        const store = saturatedWithOneSpare(5_000);
        expect(store.size).toBe(5_000);

        // The 4999 least-recently-hit buckets are all enforced limits and the single evictable
        // bucket sits behind every one of them. The newcomer must be admitted by dropping that
        // spare, not refused for the depth of the run in front of it.
        expect(store.hit('newcomer', 1, WINDOW).limited).toBe(false);
        expect(store.size).toBe(5_000);

        // No enforced bucket paid for the admission.
        for (const index of [0, 2_500, 4_998])
        {
            expect(store.hit(`enforced-${ index }`, 1, WINDOW).limited).toBe(true);
        }
    });

    it('costs the same bounded work to admit a key whatever the store is holding', () =>
    {
        const small = saturatedWithOneSpare(200);
        const large = saturatedWithOneSpare(20_000);

        const smallWork = mapWork(() =>
        {
            small.hit('newcomer', 1, WINDOW);
        });
        const largeWork = mapWork(() =>
        {
            large.hit('newcomer', 1, WINDOW);
        });

        // A hundredfold more buckets in front of the spare must not buy a single extra step.
        expect(largeWork).toBe(smallWork);
        expect(largeWork).toBeLessThanOrEqual(WORK_CEILING);
    });

    it('costs the same bounded work to refuse a key when nothing is evictable', () =>
    {
        const small = new MemoryRateStore({ maxEntries: 200 });
        saturate(small, 200);
        const large = new MemoryRateStore({ maxEntries: 20_000 });
        saturate(large, 20_000);

        let refused = 0;
        const smallWork = mapWork(() =>
        {
            refused += small.hit('newcomer', 1, WINDOW).limited ? 1 : 0;
        });
        const largeWork = mapWork(() =>
        {
            refused += large.hit('newcomer', 1, WINDOW).limited ? 1 : 0;
        });
        expect(refused).toBe(2);

        // Proving the store has nothing to give up is what an attacker cycling keys pays for
        // on every request, so it may not scale with the entry cap either.
        expect(largeWork).toBe(smallWork);
        expect(largeWork).toBeLessThanOrEqual(WORK_CEILING);
    });

    it('reaches an expired bucket buried behind live limits as refusals advance the scan', () =>
    {
        vi.useFakeTimers();
        try
        {
            const store = new MemoryRateStore({ maxEntries: 40 });
            for (let i = 0; i < 40; i++)
            {
                // One short-window bucket sits deep in the map; the rest outlive the test.
                enforce(store, `enforced-${ i }`, 1, i === 20 ? 1_000 : 600_000);
            }
            vi.advanceTimersByTime(2_000);

            let admitted = -1;
            for (let i = 0; i < 20 && admitted < 0; i++)
            {
                if (!store.hit(`newcomer-${ i }`, 1, 600_000).limited)
                {
                    admitted = i;
                }
            }

            // Each refusal moves the scan on, so the dead bucket is reached in a handful of
            // attempts instead of being stranded until the next sweep.
            expect(admitted).toBeGreaterThanOrEqual(0);
            expect(store.size).toBe(40);
            for (const index of [0, 19, 39])
            {
                expect(store.hit(`enforced-${ index }`, 1, 600_000).limited).toBe(true);
            }
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    it('reports saturation once per episode and recovers when a window resets', () =>
    {
        vi.useFakeTimers();
        try
        {
            const onSaturation = vi.fn();
            const store = new MemoryRateStore({ maxEntries: 4, onSaturation });
            for (const key of ['a', 'b', 'c', 'd'])
            {
                enforce(store, key, 1);
            }

            expect(store.hit('first', 1, WINDOW).limited).toBe(true);
            expect(onSaturation).toHaveBeenCalledTimes(1);
            expect(onSaturation).toHaveBeenCalledWith(4);

            // Still nothing evictable: a further newcomer is refused without a second report.
            expect(store.hit('second', 1, WINDOW).limited).toBe(true);
            expect(onSaturation).toHaveBeenCalledTimes(1);

            // Saturation is window-bounded, not a lockout.
            vi.advanceTimersByTime(61_000);
            expect(store.hit('third', 1, WINDOW).limited).toBe(false);

            // A fresh episode is a fresh report: the operator must see the store go under
            // again, not one announcement for the lifetime of the process.
            for (const key of ['third', 'e', 'f', 'g'])
            {
                enforce(store, key, 1);
            }
            expect(store.hit('fourth', 1, WINDOW).limited).toBe(true);
            expect(onSaturation).toHaveBeenCalledTimes(2);
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    it('a raised limit on a retained bucket reopens admission before any window resets', () =>
    {
        const store = new MemoryRateStore({ maxEntries: 2 });
        enforce(store, 'a', 1);
        enforce(store, 'b', 1);
        expect(store.hit('first', 1, WINDOW).limited).toBe(true);

        // Re-keying 'a' at a higher limit leaves it under-limit, hence evictable: the store's
        // all-enforced verdict must not outlive it.
        expect(store.hit('a', 10, WINDOW).limited).toBe(false);
        expect(store.hit('second', 1, WINDOW).limited).toBe(false);
    });

    it('a throwing onSaturation observer cannot break the refusal path', () =>
    {
        const store = new MemoryRateStore({
            maxEntries: 2,
            onSaturation: () =>
            {
                throw new Error('observer down');
            }
        });
        enforce(store, 'a', 1);
        enforce(store, 'b', 1);
        expect(store.hit('newcomer', 1, WINDOW).limited).toBe(true);
    });
});

describe('a refusal is answered by the chain owner, not by the limiter', () =>
{
    /** An app with its OWN envelope and its own error observer - what a real deployment has. */
    function appWithPolicy(): { app: App; seen: unknown[] }
    {
        const seen: unknown[] = [];
        const app = new App({
            onError: (error) =>
            {
                seen.push(error);
            },
            serializeError: ({ error, expose }) => ({ ok: false, code: error.code, message: expose ? error.message : 'error' })
        });
        app.get('/x', () => json({ ok: true }));
        return { app, seen };
    }

    it("a 429 carries the app's envelope, its observer, and the limiter's headers", async () =>
    {
        const { app, seen } = appWithPolicy();
        const handler = pipeline(app, rateLimit({ limit: 1, windowMs: 60_000, key: () => 'one' }));

        const allowed = await handler.handle(new Request('http://local/x'));
        expect(allowed.status).toBe(200);

        const refused = await handler.handle(new Request('http://local/x'));
        expect(refused.status).toBe(429);
        // The envelope the app publishes - not the kernel default. A client written against
        // the documented `ok` field read the default shape's undefined as a SUCCESS.
        expect(await refused.json()).toEqual({ ok: false, code: 'too-many-requests', message: 'Too many requests' });
        // The operator hears it.
        expect(seen).toHaveLength(1);
        // And nothing a returned Response carried is lost.
        expect(refused.headers.get('retry-after')).not.toBeNull();
        expect(refused.headers.get('ratelimit-limit')).toBe('1');
        expect(refused.headers.get('ratelimit-remaining')).toBe('0');
        expect(refused.headers.get('ratelimit-reset')).not.toBeNull();
    });

    it('a limiter with no client identity fails LOUDLY through the same policy', async () =>
    {
        const { app, seen } = appWithPolicy();
        // No key function and no socket address: the limiter cannot key, which is a
        // misconfiguration that used to answer 500 privately and reach nobody.
        const handler = pipeline(app, rateLimit({ limit: 1, windowMs: 60_000 }));

        const response = await handler.handle(new Request('http://local/x'));
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ ok: false, code: 'rate-limit-key-unavailable' });
        expect(seen).toHaveLength(1);
    });

    it('an allowed request is untouched: the app answers and no error is observed', async () =>
    {
        const { app, seen } = appWithPolicy();
        const handler = pipeline(app, rateLimit({ limit: 5, windowMs: 60_000, key: () => 'two' }));
        const response = await handler.handle(new Request('http://local/x'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(response.headers.get('ratelimit-remaining')).toBe('4');
        expect(seen).toHaveLength(0);
    });
});
