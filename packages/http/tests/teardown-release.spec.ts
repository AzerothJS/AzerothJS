// @vitest-environment node
//
// Request teardown releases the request's data cache - as the LAST act, after every user
// cleanup round, because cleanups legitimately read the settled entries (and may fetch
// fresh keys) during teardown. The release is a latch: post-teardown reads in the dead
// ALS frame degrade to direct fetches and repopulate nothing, concurrent settle paths
// share ONE teardown instead of re-entering, and a cleanup running when a second settle
// path fires still sees the live cache.
import { describe, expect, it, afterEach } from 'vitest';

import { App, onWorkUnitCleanup } from '@azerothjs/http';
import { cached } from 'azerothjs';
import { getDataCache, resetDataCache, type DataCache } from 'azerothjs/internal';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * app.handle resolves the Response without ordering it after teardown (only a socket
 * write is ordered that way), so assertions about the POST-teardown state wait for the
 * release to land - bounded, and failing loudly if it never does.
 */
async function settled(cache: DataCache | null): Promise<void>
{
    for (let i = 0; i < 100; i++)
    {
        if (cache !== null && cache.released)
        {
            return;
        }
        await wait(5);
    }
    throw new Error('teardown never released the cache');
}

afterEach(() =>
{
    resetDataCache();
});

let familySeq = 0;
const familyName = (): string => `teardown-spec-${ familySeq++ }`;

describe('teardown releases the request cache', () =>
{
    it('the dominant no-cleanups path releases: nothing survives the request', async () =>
    {
        const family = cached(familyName(), () => Promise.resolve('value'));
        let cache: DataCache | null = null;
        const app = new App();
        app.get('/x', async () =>
        {
            await family();
            cache = getDataCache();
            return new Response('ok');
        });
        await (await app.handle(new Request('http://local/x'))).text();
        expect(cache).not.toBeNull();
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('a same-key cleanup read is served from the settled entry; a fresh-key cleanup read is swept afterward', async () =>
    {
        let fetches = 0;
        const family = cached(familyName(), (key: string) =>
        {
            fetches++;
            return Promise.resolve(`v:${ key }`);
        });
        let cache: DataCache | null = null;
        let cleanupSameKey: string | undefined;
        let cleanupFreshKey: string | undefined;
        const app = new App();
        app.get('/x', async () =>
        {
            await family('handler');
            cache = getDataCache();
            onWorkUnitCleanup(async () =>
            {
                // Runs during teardown, BEFORE the release: the settled entry serves.
                cleanupSameKey = await family('handler');
                cleanupFreshKey = await family('fresh');
            });
            return new Response('ok');
        });
        await (await app.handle(new Request('http://local/x'))).text();
        await settled(cache);
        expect(cleanupSameKey).toBe('v:handler');
        expect(cleanupFreshKey).toBe('v:fresh');
        // The same-key read cost no fetch (settled entry); the fresh key fetched once.
        expect(fetches).toBe(2);
        // And the release that FOLLOWS the cleanup rounds swept the repopulation.
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('a detached reader resolves undefined at teardown AND its entry/timer are freed - at the shipped default retain', async () =>
    {
        let settleLate!: (value: string) => void;
        const family = cached(familyName(), () => new Promise<string>((resolve) =>
        {
            settleLate = resolve;
        }));
        let cache: DataCache | null = null;
        let detached: Promise<string> | null = null;
        let entry: { retainTimer: unknown } | undefined;
        const app = new App();
        app.get('/x', () =>
        {
            detached = family();
            cache = getDataCache();
            // The entry object itself: a post-release re-arm fires on it after eviction,
            // where the (empty) map cannot show it.
            entry = (cache as unknown as DataCache).allEntries()[0];
            return new Response('ok');
        });
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => void rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try
        {
            await (await app.handle(new Request('http://local/x'))).text();
            await settled(cache);
            await expect(detached).resolves.toBeUndefined();
            settleLate('late');
            await wait(10);
        }
        finally
        {
            process.off('unhandledRejection', onRejection);
        }
        expect(rejections).toEqual([]);
        // The disposal half: released, empty, and no timer re-armed by the late settle -
        // this family runs at the SHIPPED default retain, so a surviving timer on the
        // captured entry would be the five-minute pin the map cannot show.
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
        expect(entry).toBeDefined();
        expect(entry?.retainTimer).toBeNull();
    });

    it('post-teardown reads in the dead ALS frame direct-fetch and repopulate nothing', async () =>
    {
        let fetches = 0;
        const family = cached(familyName(), (key: string) =>
        {
            fetches++;
            return Promise.resolve(`v${ fetches }:${ key }`);
        });
        let cache: DataCache | null = null;
        let lateRead: Promise<string> | null = null;
        let lateResolve!: () => void;
        const late = new Promise<void>((resolve) =>
        {
            lateResolve = resolve;
        });
        const app = new App();
        app.get('/x', async () =>
        {
            await family('k');
            cache = getDataCache();
            setTimeout(() =>
            {
                // Fires ~long after teardown, still inside the dead ALS frame.
                lateRead = family('k');
                lateResolve();
            }, 30);
            return new Response('ok');
        });
        await (await app.handle(new Request('http://local/x'))).text();
        await settled(cache);
        await late;
        // Correct data via a fresh direct fetch - not the dead request's entry - and the
        // released cache stays empty.
        await expect(lateRead).resolves.toBe('v2:k');
        expect(fetches).toBe(2);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('a late-registered cleanup (after settle) runs immediately, reads via direct fetch, repopulates nothing', async () =>
    {
        let fetches = 0;
        const family = cached(familyName(), () =>
        {
            fetches++;
            return Promise.resolve(`v${ fetches }`);
        });
        let cache: DataCache | null = null;
        let lateValue: string | undefined;
        let registerLate!: () => void;
        const registered = new Promise<void>((resolve) =>
        {
            registerLate = resolve;
        });
        const app = new App();
        app.get('/x', async () =>
        {
            await family();
            cache = getDataCache();
            setTimeout(() =>
            {
                onWorkUnitCleanup(async () =>
                {
                    lateValue = await family();
                });
                // runLate executes the cleanup on registration once settled; give its
                // microtasks a beat before asserting.
                setTimeout(registerLate, 10);
            }, 20);
            return new Response('ok');
        });
        await (await app.handle(new Request('http://local/x'))).text();
        await settled(cache);
        await registered;
        expect(lateValue).toBe('v2');
        expect(fetches).toBe(2);
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('stream pulls read the request cache mid-body; release happens only at stream end', async () =>
    {
        let fetches = 0;
        const family = cached(familyName(), (key: string) =>
        {
            fetches++;
            return Promise.resolve(`v:${ key }`);
        });
        let cache: DataCache | null = null;
        let releasedDuringPulls = false;
        let pulls = 0;
        const app = new App();
        app.get('/x', () =>
        {
            cache = getDataCache();
            const capturedCache = cache;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                async pull(controller): Promise<void>
                {
                    pulls++;
                    // The legitimate long-lived-scope shape: mid-body reads resolve the REQUEST
                    // cache and must hit the handler-settled entry; a release any
                    // earlier than stream end breaks exactly this.
                    const value = await family('s1');
                    releasedDuringPulls ||= (capturedCache as unknown as DataCache).released;
                    controller.enqueue(encoder.encode(value));
                    if (pulls >= 3)
                    {
                        controller.close();
                    }
                }
            });
            return new Response(body, { headers: { 'content-type': 'text/plain' } });
        });
        const response = await app.handle(new Request('http://local/x'));
        const text = await response.text();
        await settled(cache);
        expect(text).toBe('v:s1v:s1v:s1');
        expect(pulls).toBe(3);
        expect(fetches).toBe(1);
        expect(releasedDuringPulls).toBe(false);
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });

    it('concurrent settle paths share ONE teardown: a cleanup mid-run keeps the live cache when a second path fires', async () =>
    {
        let fetches = 0;
        const family = cached(familyName(), (key: string) =>
        {
            fetches++;
            return Promise.resolve(`v:${ key }`);
        });
        let cache: DataCache | null = null;
        let holdCleanup!: () => void;
        const held = new Promise<void>((resolve) =>
        {
            holdCleanup = resolve;
        });
        let midCleanupRead: string | undefined;
        const controller = new AbortController();
        const app = new App();
        app.get('/x', async () =>
        {
            await family('k');
            cache = getDataCache();
            onWorkUnitCleanup(async () =>
            {
                // Teardown entrant 1 is inside this await when entrant 2 (the abort
                // listener) fires; single-entrancy means the second path AWAITS this
                // teardown instead of taking the early return and releasing under us.
                await held;
                midCleanupRead = await family('k');
            });
            return new Response('ok');
        });
        const handled = app.handle(new Request('http://local/x', { signal: controller.signal }))
            .then((response) => response.text());
        await wait(20);
        // The response settled; teardown entrant 1 is parked inside the held cleanup.
        controller.abort();
        await wait(10);
        holdCleanup();
        await handled.catch(() => undefined);
        await settled(cache);
        // The mid-teardown read saw the SETTLED entry (0-cost), not a released cache.
        expect(midCleanupRead).toBe('v:k');
        expect(fetches).toBe(1);
        expect((cache as unknown as DataCache).released).toBe(true);
        expect((cache as unknown as DataCache).allEntries().length).toBe(0);
    });
});
