/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The data cache's core semantics through the public faces: cached() families sharing one
// fetch per key, the entry-to-instance notification edge, the read machine's staleness and
// error rows, the revalidate await contract, settlement carry-over under force, the server
// latch, retention, and the untouched plain-fetcher island path.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot, createResource, cached, revalidate } from 'azerothjs';
import type { Resource } from 'azerothjs';
import { resetDataCache, latchServerData } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() =>
{
    resetDataCache();
});

/** Builds resources inside a disposable root and hands back both. */
function rooted<T>(build: () => T): { built: T; dispose: () => void }
{
    let dispose!: () => void;
    const built = createRoot((d) =>
    {
        dispose = d;
        return build();
    });
    return { built, dispose };
}

describe('cached - shared fetches', () =>
{
    it('two resources over one cached key issue ONE fetch and both settle', async () =>
    {
        let fetches = 0;
        const getThing = cached('thing-one-fetch', async () =>
        {
            fetches += 1;
            return 'payload';
        });
        const { built, dispose } = rooted(() =>
            [createResource(getThing), createResource(getThing)] as const);
        try
        {
            await flush();
            expect(fetches).toBe(1);
            expect(built[0].data()).toBe('payload');
            expect(built[1].data()).toBe('payload');
        }
        finally
        {
            dispose();
        }
    });

    it('different args are different entries', async () =>
    {
        const seen: number[] = [];
        const getUser = cached('user-by-id', async (id: number) =>
        {
            seen.push(id);
            return `user-${ id }`;
        });
        const { built, dispose } = rooted(() =>
            [createResource(() => 1, getUser), createResource(() => 2, getUser)] as const);
        try
        {
            await flush();
            expect([...seen].sort()).toEqual([1, 2]);
            expect(built[0].data()).toBe('user-1');
            expect(built[1].data()).toBe('user-2');
        }
        finally
        {
            dispose();
        }
    });

    it('two concurrent DIRECT calls share one fetch', async () =>
    {
        let fetches = 0;
        const getConfig = cached('config-direct', async () =>
        {
            fetches += 1;
            await Promise.resolve();
            return { flag: true };
        });
        const [a, b] = await Promise.all([getConfig(), getConfig()]);
        expect(fetches).toBe(1);
        expect(a).toEqual({ flag: true });
        expect(b).toBe(a);
    });

    it('a plain (un-cached) fetcher keeps island semantics: two instances, two fetches', async () =>
    {
        let fetches = 0;
        const fetcher = async (): Promise<string> =>
        {
            fetches += 1;
            return 'x';
        };
        const { dispose } = rooted(() =>
        {
            createResource(fetcher);
            createResource(fetcher);
        });
        try
        {
            await flush();
            expect(fetches).toBe(2);
        }
        finally
        {
            dispose();
        }
    });
});

describe('the notification edge', () =>
{
    it('revalidate(family) refetches and updates a live subscriber\'s data()', async () =>
    {
        let serial = 0;
        const getSerial = cached('serial-edge', async () =>
        {
            serial += 1;
            return serial;
        });
        const { built: view, dispose } = rooted(() => createResource(getSerial));
        try
        {
            await flush();
            expect(view.data()).toBe(1);
            await revalidate(getSerial);
            // The screen, not just the entry: the instance signal updated.
            expect(view.data()).toBe(2);
        }
        finally
        {
            dispose();
        }
    });

    it('a background revalidation reports through refreshing, never loading', async () =>
    {
        let release!: (v: string) => void;
        let first = true;
        const getSlow = cached('slow-refresh', async () =>
        {
            if (first)
            {
                first = false;
                return 'initial';
            }
            return new Promise<string>((r) =>
            {
                release = r;
            });
        });
        const { built: view, dispose } = rooted(() => createResource(getSlow));
        try
        {
            await flush();
            expect(view.data()).toBe('initial');
            const settled = revalidate(getSlow);
            await flush();
            // Mid-revalidation: retained data on screen, refreshing true.
            expect(view.data()).toBe('initial');
            expect(view.loading()).toBe(false);
            expect(view.refreshing()).toBe(true);
            release('fresh');
            await settled;
            expect(view.data()).toBe('fresh');
            expect(view.refreshing()).toBe(false);
        }
        finally
        {
            dispose();
        }
    });
});

describe('the read machine', () =>
{
    it('a persistently failing endpoint does not retry in a spin', async () =>
    {
        let attempts = 0;
        const getBroken = cached('broken-no-spin', async () =>
        {
            attempts += 1;
            throw new Error(`fail-${ attempts }`);
        });
        const { built: view, dispose } = rooted(() => createResource(getBroken));
        try
        {
            await flush();
            await flush();
            await flush();
            expect(attempts).toBe(1); // settle-fail wakes never re-fetch
            expect((view.error() as Error).message).toBe('fail-1');
        }
        finally
        {
            dispose();
        }
    });

    it('a NEW subscriber retries an errored entry - failures are not cached', async () =>
    {
        let attempts = 0;
        const getFlaky = cached('flaky-retry', async () =>
        {
            attempts += 1;
            if (attempts === 1)
            {
                throw new Error('first-down');
            }
            return 'recovered';
        });
        const first = rooted(() => createResource(getFlaky));
        await flush();
        expect(attempts).toBe(1);
        first.dispose();

        const second = rooted(() => createResource(getFlaky));
        try
        {
            await flush();
            expect(attempts).toBe(2);
            expect(second.built.data()).toBe('recovered');
        }
        finally
        {
            second.dispose();
        }
    });

    it('re-subscription serves the retained value sync and revalidates behind it (fresh: 0)', async () =>
    {
        let serial = 0;
        const getFeed = cached('feed-swr', async () =>
        {
            serial += 1;
            return `page-${ serial }`;
        });
        const first = rooted(() => createResource(getFeed));
        await flush();
        first.dispose(); // leave: subscriber count drops to zero, value retained
        await flush();

        const back = rooted(() => createResource(getFeed));
        try
        {
            // Synchronous serve at effect creation: no loading flash.
            expect(back.built.data()).toBe('page-1');
            expect(back.built.loading()).toBe(false);
            await flush();
            expect(serial).toBe(2); // the background revalidation ran
            expect(back.built.data()).toBe('page-2');
        }
        finally
        {
            back.dispose();
        }
    });

    it('fresh: Infinity opts a family out of resubscribe revalidation', async () =>
    {
        let serial = 0;
        const getStatic = cached('static-fresh', async () =>
        {
            serial += 1;
            return serial;
        }, { fresh: Infinity });
        const first = rooted(() => createResource(getStatic));
        await flush();
        first.dispose();
        await flush();

        const back = rooted(() => createResource(getStatic));
        try
        {
            await flush();
            expect(back.built.data()).toBe(1);
            expect(serial).toBe(1); // no resubscribe fetch
        }
        finally
        {
            back.dispose();
        }
    });
});

describe('revalidate - the await contract', () =>
{
    it('revalidate against an IN-FLIGHT entry resolves only after the post-mark fetch', async () =>
    {
        const gates: ((v: string) => void)[] = [];
        let calls = 0;
        const getRacy = cached('racy-mark', async () =>
        {
            calls += 1;
            return new Promise<string>((r) =>
            {
                gates.push(r);
            });
        });
        const { built: view, dispose } = rooted(() => createResource(getRacy));
        try
        {
            await flush();
            expect(calls).toBe(1); // pre-mark fetch in flight
            const settled = revalidate(getRacy);
            let resolved = false;
            void settled.then(() =>
            {
                resolved = true;
            });
            gates[0]!('pre-mark');
            await flush();
            // The pre-mark settle must NOT resolve the awaiter; the follow-up runs.
            expect(resolved).toBe(false);
            expect(calls).toBe(2);
            gates[1]!('post-mark');
            await settled;
            expect(view.data()).toBe('post-mark');
        }
        finally
        {
            dispose();
        }
    });

    it('revalidate on an UNSUBSCRIBED entry resolves at the mark without fetching', async () =>
    {
        let calls = 0;
        const getIdle = cached('idle-mark', async () =>
        {
            calls += 1;
            return calls;
        });
        const first = rooted(() => createResource(getIdle));
        await flush();
        first.dispose(); // unsubscribe; value retained
        await flush();

        await revalidate(getIdle); // resolves at mark
        expect(calls).toBe(1); // nothing was watching; no fetch
    });
});

describe('refetch - force through the entry', () =>
{
    it('returns a promise that resolves at the forced settle, and co-subscribers update too', async () =>
    {
        let serial = 0;
        const getShared = cached('shared-force', async () =>
        {
            serial += 1;
            return serial;
        });
        const { built, dispose } = rooted(() =>
            [createResource(getShared), createResource(getShared)] as const);
        try
        {
            await flush();
            expect(built[0].data()).toBe(1);
            await built[0].refetch();
            await flush();
            expect(built[0].data()).toBe(2);
            expect(built[1].data()).toBe(2); // the co-subscriber saw the same settle
        }
        finally
        {
            dispose();
        }
    });

    it('a skip-value source resolves refetch immediately', async () =>
    {
        const getById = cached('skip-refetch', async (id: number) => id);
        const { built: view, dispose } = rooted(() =>
            createResource(() => null as number | null, getById));
        try
        {
            await flush();
            await view.refetch(); // no key, resolves without fetching
            expect(view.data()).toBeUndefined();
        }
        finally
        {
            dispose();
        }
    });
});

describe('the server latch', () =>
{
    it('latched default-scope reads bypass the cache: sequential direct calls each fetch', async () =>
    {
        let fetches = 0;
        const getData = cached('latched-bypass', async () =>
        {
            fetches += 1;
            return fetches;
        });
        latchServerData();
        const first = await getData();
        const second = await getData();
        expect(first).toBe(1);
        expect(second).toBe(2); // no cross-call entry survived
    });
});

describe('family re-registration (the HMR shape)', () =>
{
    it('re-registering a name with a different fetcher replaces it and invalidates entries', async () =>
    {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        let view!: Resource<string>;
        let dispose!: () => void;
        try
        {
            const getV1 = cached('hmr-family', async () => 'v1');
            const rootedView = rooted(() => createResource(getV1));
            view = rootedView.built;
            dispose = rootedView.dispose;
            await flush();
            expect(view.data()).toBe('v1');

            cached('hmr-family', async () => 'v2');
            expect(info).toHaveBeenCalledOnce();
            await flush();
            await flush();
            // The live subscriber refetched through the NEW module's code.
            expect(view.data()).toBe('v2');
        }
        finally
        {
            dispose();
            info.mockRestore();
        }
    });
});

describe('key fidelity', () =>
{
    it('Date args key on their JSON form: distinct dates are distinct entries', async () =>
    {
        const seen: string[] = [];
        const byDay = cached('report-by-day', async (day: Date) =>
        {
            seen.push(day.toISOString());
            return day.toISOString();
        });
        const a = await byDay(new Date('2026-01-01T00:00:00Z'));
        const b = await byDay(new Date('2020-05-05T00:00:00Z'));
        expect(a).toBe('2026-01-01T00:00:00.000Z');
        expect(b).toBe('2020-05-05T00:00:00.000Z');
        expect(seen).toHaveLength(2);
    });

    it('an exotic arg without toJSON throws in DEV instead of collapsing entries', () =>
    {
        const byMap = cached('report-by-map', async (input: Map<string, number>) => input.size);
        // Synchronous, at the call site - the key is computed before any fetch exists.
        expect(() => byMap(new Map([['a', 1]]))).toThrow(/plain data or carry toJSON/);
    });
});

describe('reentrancy', () =>
{
    it('revalidate from inside the key\'s own fetcher warns and resolves at the mark - no deadlock', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            let calls = 0;
            const getSelf: { fn?: ReturnType<typeof cached> } = {};
            getSelf.fn = cached('self-target', async () =>
            {
                calls += 1;
                await revalidate(getSelf.fn, []);
                return calls;
            });
            const { built: view, dispose } = rooted(() => createResource(getSelf.fn as never));
            try
            {
                await flush();
                expect(view.data()).toBe(1); // settled - the deadlock did not happen
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('inside its own fetcher'));
            }
            finally
            {
                dispose();
            }
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('a DIFFERENT-key revalidate inside a fetcher works - the 401-refresh pattern', async () =>
    {
        let tokenIssues = 0;
        const getToken = cached('auth-token', async () =>
        {
            tokenIssues += 1;
            return `token-${ tokenIssues }`;
        });
        const getProtected = cached('protected-data', async () =>
        {
            await revalidate(getToken);
            const token = await getToken();
            return `data-with-${ token }`;
        });
        const value = await getProtected();
        expect(value).toBe('data-with-token-1');
    });
});

describe('retention', () =>
{
    it('an unsubscribed entry is evicted after its retain window and refetches on return', async () =>
    {
        let serial = 0;
        const getEvicted = cached('evict-me', async () =>
        {
            serial += 1;
            return serial;
        }, { retain: 5, fresh: Infinity });
        const first = rooted(() => createResource(getEvicted));
        await flush();
        first.dispose(); // retention clock starts
        await new Promise((resolve) => setTimeout(resolve, 30));

        const back = rooted(() => createResource(getEvicted));
        try
        {
            await flush();
            // fresh: Infinity would have served the retained value; eviction forced a
            // real refetch instead.
            expect(serial).toBe(2);
            expect(back.built.data()).toBe(2);
        }
        finally
        {
            back.dispose();
        }
    });
});
