/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A cache's lifetime is decided by its scope, not by process flags: retention timers arm
// in EVERY cache (an entry nobody holds dies after its retain window wherever it lives),
// a scope-owning host releases its cache at scope end, release is a LATCH the arming path
// consults (not an event the microtask queue can outrun), and the DEV registry admits only
// app-scope caches - the invalidation walk's one consumer. The render entry points are
// scope-creating hosts too, and release their own render scope.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Suspense, cached, createResource, h, onRootDispose, renderToStream, renderToString } from 'azerothjs';
import type {
    DataCache } from 'azerothjs/internal';
import {
    cachedFamilyOf,
    getDataCache,
    latchServerData,
    releaseDataCache,
    resetDataCache,
    setStoreScopeResolver
} from 'azerothjs/internal';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() =>
{
    setStoreScopeResolver(null);
    resetDataCache();
    vi.restoreAllMocks();
});

let familySeq = 0;
const familyName = (): string => `retention-spec-${ familySeq++ }`;

describe('retention arms in every scope - the latch no longer disables eviction', () =>
{
    it('a latched long-lived scope evicts unheld entries at their retain window - to exactly zero', async () =>
    {
        latchServerData();
        const scope = {};
        setStoreScopeResolver(() => scope);
        const family = cached(familyName(), (n: number) => Promise.resolve(n), { retain: 10 });
        let cache: DataCache | null = null;
        await Promise.all(Array.from({ length: 20000 }, (unused, n) =>
        {
            void unused;
            return family(n).then(() =>
            {
                cache ??= getDataCache();
            });
        }));
        expect(cache).not.toBeNull();
        expect((cache as unknown as DataCache).allEntries().length).toBeGreaterThan(0);
        await wait(150);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    }, 30000);

    it('the unlatched control behaves identically - the latch no longer decides retention', async () =>
    {
        const scope = {};
        setStoreScopeResolver(() => scope);
        const family = cached(familyName(), (n: number) => Promise.resolve(n), { retain: 10 });
        await Promise.all([family(1), family(2), family(3)]);
        const cache = getDataCache();
        expect(cache).not.toBeNull();
        await wait(50);
        expect((cache as DataCache).allEntries().length).toBe(0);
    });
});

describe('release is a latch, not an event', () =>
{
    it('a detached reader resolved BY release cannot re-arm a timer on the released cache', async () =>
    {
        const scope = {};
        setStoreScopeResolver(() => scope);
        let settle!: (value: string) => void;
        const family = cached(familyName(), () => new Promise<string>((resolve) =>
        {
            settle = resolve;
        }));
        // Detached: never awaited before release; its waiter is resolved by release itself,
        // and the readValue continuation then runs the zero-check AFTER release returned.
        const detached = family();
        await wait(0);
        const cache = getDataCache() as DataCache;
        // Capture the ENTRY OBJECT before release: the re-arm fires on the evicted entry,
        // whose timer closure pins the cache while the map - and allEntries() - stay
        // empty. Asserting through the map alone is exactly the vacuous shape the
        // sabotaged-gate run exposed.
        const [entry] = cache.allEntries();
        expect(entry).toBeDefined();
        expect(cache.released).toBe(false);
        releaseDataCache(scope);
        expect(cache.released).toBe(true);
        await expect(detached).resolves.toBeUndefined();
        settle('late');
        await wait(10);
        expect(cache.allEntries().length).toBe(0);
        // The event-vs-latch pin: without the #released gate in the arming path, the
        // zero-check re-arms a default-retain timer on THIS entry object.
        expect(entry?.retainTimer).toBeNull();
    });

    it('a read reaching a released cache degrades to the cache-disabled path: fresh fetch, nothing stored', async () =>
    {
        const scope = {};
        setStoreScopeResolver(() => scope);
        let fetches = 0;
        const family = cached(familyName(), () =>
        {
            fetches++;
            return Promise.resolve(`v${ fetches }`);
        });
        await expect(family()).resolves.toBe('v1');
        await expect(family()).resolves.toBe('v1');
        expect(fetches).toBe(1);
        releaseDataCache(scope);
        expect(getDataCache()).toBeNull();
        await expect(family()).resolves.toBe('v2');
        await expect(family()).resolves.toBe('v3');
        expect(fetches).toBe(3);
    });
});

describe('the render entry points are scope-owning hosts', () =>
{
    it('a buffered render releases its render-scope cache in the same frame - success and THROW alike', async () =>
    {
        latchServerData();
        const family = cached(familyName(), () => Promise.resolve('x'));
        let captured: DataCache | null = null;
        renderToString(() =>
        {
            void family();
            captured = getDataCache();
            return { html: '<i></i>' } as unknown as HTMLElement;
        });
        expect(captured).not.toBeNull();
        expect((captured as unknown as DataCache).released).toBe(true);
        expect((captured as unknown as DataCache).allEntries().length).toBe(0);

        let thrown: DataCache | null = null;
        expect(() => renderToString(() =>
        {
            void family();
            thrown = getDataCache();
            throw new Error('render died');
        })).toThrow('render died');
        expect(thrown).not.toBeNull();
        expect((thrown as unknown as DataCache).released).toBe(true);
        expect((thrown as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('a streamed render releases at finalize - the settled shape and the thrown main pass', async () =>
    {
        latchServerData();
        const family = cached(familyName(), () => Promise.resolve('x'));
        let captured: DataCache | null = null;
        const stream = renderToStream(() =>
        {
            void family();
            captured = getDataCache();
            return { html: '<i></i>' } as unknown as HTMLElement;
        });
        // No pending boundaries: the session finalizes inside the constructor.
        expect(captured).not.toBeNull();
        expect((captured as unknown as DataCache).released).toBe(true);
        await stream.getReader().cancel();

        let thrown: DataCache | null = null;
        expect(() => renderToStream(() =>
        {
            void family();
            thrown = getDataCache();
            throw new Error('main pass died');
        })).toThrow('main pass died');
        // The main-pass throw builds no stream at all: only the finalize funnel can
        // release here, which is why the wiring lives on session.onFinalize.
        expect(thrown).not.toBeNull();
        expect((thrown as unknown as DataCache).released).toBe(true);
        expect((thrown as unknown as DataCache).allEntries().length).toBe(0);
    });
});

describe('release orders after dispose, and the drive gate stops post-cancel work', () =>
{
    it('a root cleanup reading a cached family during dispose sees the SETTLED entry, not a released cache', async () =>
    {
        latchServerData();
        let fetches = 0;
        const family = cached(familyName(), () =>
        {
            fetches++;
            return Promise.resolve('x');
        });
        renderToString(() =>
        {
            void family();
            onRootDispose(() =>
            {
                // Dispose runs BEFORE release (the same order the stream host's
                // finalizers run): this read must serve the settled entry - a released
                // cache here double-invokes the fetcher per render.
                void family();
            });
            return { html: '<i></i>' } as unknown as HTMLElement;
        });
        await wait(10);
        expect(fetches).toBe(1);
    });

    it('cancelling a stream with a pending boundary releases the cache and schedules NO post-cancel work', async () =>
    {
        latchServerData();
        let resolveLate!: (value: string) => void;
        const late = new Promise<string>((resolve) =>
        {
            resolveLate = resolve;
        });
        let childRenders = 0;
        let captured: DataCache | null = null;
        const stream = renderToStream(() =>
        {
            captured = getDataCache();
            const resource = createResource<string>(() => late);
            return Suspense({
                fallback: () => h('i', {}, 'loading'),
                on: [resource],
                children: () =>
                {
                    childRenders++;
                    return h('b', {}, resource.data() ?? '');
                }
            });
        });
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel();
        expect((captured as unknown as DataCache).released).toBe(true);
        // The boundary settles AFTER the cancel: without the finalized term in drive's
        // gate the continuation renders into the cancelled controller - that is a
        // process-fatal ERR_INVALID_STATE.
        resolveLate('late');
        await wait(20);
        expect(childRenders).toBe(0);
    });
});

describe('the DEV registry admits app-scope caches only, and the walk says what it does', () =>
{
    it('an HMR fetcher swap revalidates the APP-scope entry and leaves the request-scope entry alone', async () =>
    {
        const name = familyName();
        const calls: string[] = [];
        const f1 = (key: string): Promise<string> =>
        {
            calls.push(`f1:${ key }`);
            return Promise.resolve(`v1:${ key }`);
        };
        const famA = cached(name, f1);
        // App-scope entry (default scope - no resolver installed).
        await famA('app');
        // Request-scope entry, un-latched: the shape that WAS walked before this design.
        const scope = {};
        setStoreScopeResolver(() => scope);
        await famA('req');
        const requestCache = getDataCache() as DataCache;
        setStoreScopeResolver(null);

        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const f2 = (key: string): Promise<string> =>
        {
            calls.push(`f2:${ key }`);
            return Promise.resolve(`v2:${ key }`);
        };
        cached(name, f2);
        await wait(10);
        // The app-scope entry went stale and lazily refetches through the NEW code; the
        // request-scope entry is scope-owned and the walk never reaches it.
        expect(await famA('app')).toBe('v2:app');
        const requestEntries = requestCache.allEntries();
        expect(requestEntries.some((entry) => entry.stale)).toBe(false);
        expect(calls.filter((c) => c === 'f2:req')).toHaveLength(0);
        // And the log claims exactly that, no more.
        const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('app-scope entries invalidated');
        expect(logged).not.toMatch(/'[^']*' re-registered; entries invalidated\./);
    });

    it('a same-reference re-registration keeps the shared record, so a LATER swap still reaches live entries', async () =>
    {
        const name = familyName();
        const calls: string[] = [];
        const f1 = (key: string): Promise<string> =>
        {
            calls.push(`f1:${ key }`);
            return Promise.resolve(`v1:${ key }`);
        };
        const famA = cached(name, f1);
        await famA('a');
        // The severing sequence: same reference, different options - the record must be
        // KEPT (and the options copied), not replaced.
        const famB = cached(name, f1, { retain: 120000 });
        expect(cachedFamilyOf(famB)?.retain).toBe(120000);
        expect(cachedFamilyOf(famA)).toBe(cachedFamilyOf(famB));
        // Now a genuine swap: live entries must refetch through the NEW fetcher. Under
        // the severed record they re-settled through f1 while the log claimed otherwise.
        const f2 = (key: string): Promise<string> =>
        {
            calls.push(`f2:${ key }`);
            return Promise.resolve(`v2:${ key }`);
        };
        cached(name, f2);
        await wait(10);
        expect(await famA('a')).toBe('v2:a');
        expect(calls).toContain('f2:a');
    });
});
