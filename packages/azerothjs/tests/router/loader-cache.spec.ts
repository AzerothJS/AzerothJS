/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The router's loader keying over the data cache: the refetch blast radius confined to the
// levels whose inputs changed, search-schema keys with normalization, parent delivery from
// the cached entry under partial re-runs, renewal propagation along the awaited edge,
// route-position identity across same-path siblings, seed adoption (fresh, stale-heal,
// static, rejected v2), and back-navigation serving from the cache.
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, createRouter, createMemoryHistory, matchAndLoad, LOADER_HANDOFF_VERSION } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() =>
{
    resetDataCache();
});

async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void> | void, seed?: unknown): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({
            routes,
            history: createMemoryHistory(initialUrl),
            ...(seed !== undefined ? { initialLoaderData: seed as never } : {})
        });
    });
    try
    {
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

describe('the refetch blast radius', () =>
{
    it('a leaf-param change runs ONLY the leaf; a schema-less query change runs both', async () =>
    {
        let parentRuns = 0;
        let childRuns = 0;
        const routes: Route[] =
        [{
            path: '/users',
            component: leaf,
            loader: async () =>
            {
                parentRuns += 1;
                return 'users';
            },
            children:
            [{
                path: ':id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    childRuns += 1;
                    return params.id;
                }
            }]
        }];
        await withRouter(routes, '/users/1', async (router) =>
        {
            await flush();
            expect(parentRuns).toBe(1);
            expect(childRuns).toBe(1);

            router.navigate('/users/2');
            await flush();
            // The parent's inputs did not change: it does NOT re-run.
            expect(parentRuns).toBe(1);
            expect(childRuns).toBe(2);
            expect(router.loaders[1]!.data()).toBe('2');

            router.navigate('/users/2?tab=posts');
            await flush();
            // No search schema anywhere: the full search string is in every key, so a
            // query-only change keeps today's refetch-everything semantics.
            expect(parentRuns).toBe(2);
            expect(childRuns).toBe(3);
        });
    });

    it('a search schema confines query dependencies to the declared, normalized subset', async () =>
    {
        let runs = 0;
        const routes: Route[] =
        [{
            path: '/items',
            component: leaf,
            search: {
                safeParse: (value: unknown) =>
                {
                    const query = value as Record<string, unknown>;
                    return { ok: true as const, value: { page: Number(query.page ?? 1) } };
                }
            },
            loader: async ({ query }) =>
            {
                runs += 1;
                return query;
            }
        }];
        await withRouter(routes, '/items', async (router) =>
        {
            await flush();
            expect(runs).toBe(1);
            // The loader received the PARSED output: defaults applied.
            expect(router.loaders[0]!.data()).toEqual({ page: 1 });

            router.navigate('/items?page=1');
            await flush();
            // ?page=1 normalizes to the same key as the bare URL: no refetch.
            expect(runs).toBe(1);

            router.navigate('/items?page=1&utm=x');
            await flush();
            // An undeclared param is outside the schema's output: no refetch.
            expect(runs).toBe(1);

            router.navigate('/items?page=2');
            await flush();
            expect(runs).toBe(2);
            expect(router.loaders[0]!.data()).toEqual({ page: 2 });
        });
    });
});

describe('parent delivery from the entry', () =>
{
    it('a leaf navigation hands the child the parent\'s CACHED data - never undefined', async () =>
    {
        const parentSeen: unknown[] = [];
        const routes: Route[] =
        [{
            path: '/org',
            component: leaf,
            loader: async () => ({ org: 'acme' }),
            children:
            [{
                path: ':id',
                component: leaf,
                loader: async ({ params, parent }) =>
                {
                    const above = await parent;
                    parentSeen.push(above);
                    return `${ (above as { org: string }).org }:${ params.id }`;
                }
            }]
        }];
        await withRouter(routes, '/org/1', async (router) =>
        {
            await flush();
            expect(router.loaders[1]!.data()).toBe('acme:1');

            router.navigate('/org/2');
            await flush();
            // The parent did NOT re-run; its entry delivered the retained value.
            expect(parentSeen).toEqual([{ org: 'acme' }, { org: 'acme' }]);
            expect(router.loaders[1]!.data()).toBe('acme:2');
        });
    });

    it('a parent renewal re-runs the child that awaited it and leaves the one that did not', async () =>
    {
        let parentRuns = 0;
        let awaiterRuns = 0;
        let lonerRuns = 0;
        const routes: Route[] =
        [{
            path: '/a',
            component: leaf,
            loader: async () =>
            {
                parentRuns += 1;
                return parentRuns;
            },
            children:
            [{
                path: 'awaits',
                component: leaf,
                loader: async ({ parent }) =>
                {
                    awaiterRuns += 1;
                    return `saw-${ String(await parent) }`;
                }
            },
            {
                path: 'ignores',
                component: leaf,
                loader: async () =>
                {
                    lonerRuns += 1;
                    return 'independent';
                }
            }]
        }];
        await withRouter(routes, '/a/awaits', async (router) =>
        {
            await flush();
            expect(router.loaders[1]!.data()).toBe('saw-1');

            await router.loaders[0]!.refetch();
            await flush();
            await flush();
            // The awaiting child rode the renewal edge and re-ran with the NEW parent data.
            expect(parentRuns).toBe(2);
            expect(awaiterRuns).toBe(2);
            expect(router.loaders[1]!.data()).toBe('saw-2');
            expect(lonerRuns).toBe(0); // never mounted, never fetched
        });
    });
});

describe('route-position identity', () =>
{
    it('same-path sibling layouts with different loaders never serve each other\'s data', async () =>
    {
        const routes: Route[] =
        [
            {
                path: '/admin',
                component: leaf,
                loader: async () => 'for-users',
                children: [{ path: 'users', component: leaf }]
            },
            {
                path: '/admin',
                component: leaf,
                loader: async () => 'for-settings',
                children: [{ path: 'settings', component: leaf }]
            }
        ];
        await withRouter(routes, '/admin/users', async (router) =>
        {
            await flush();
            expect(router.loaders[0]!.data()).toBe('for-users');

            router.navigate('/admin/settings');
            await flush();
            // Distinct route objects, identical joined pattern: their POSITIONS differ, so
            // their keys differ and the second layout runs ITS loader.
            expect(router.loaders[0]!.data()).toBe('for-settings');
        });
    });
});

describe('seed adoption', () =>
{
    const seededRoutes = (onRun: () => void): Route[] =>
        [{
            path: '/users/:id',
            component: leaf,
            loader: async ({ params }) =>
            {
                onRun();
                return { id: params.id, from: 'network' };
            }
        }];

    it('a FRESH seed adopts with zero fetches and serves synchronously', async () =>
    {
        let runs = 0;
        const seed = { version: LOADER_HANDOFF_VERSION, path: '/users/7', data: [{ id: '7', from: 'server' }], at: Date.now() };
        await withRouter(seededRoutes(() => runs++), '/users/7', async (router) =>
        {
            expect(router.loaders[0]!.data()).toEqual({ id: '7', from: 'server' });
            await flush();
            await flush();
            expect(runs).toBe(0);
        }, seed);
    });

    it('a STATIC seed adopts fresh regardless of age - SSG hydration fetches nothing', async () =>
    {
        let runs = 0;
        const seed = { version: LOADER_HANDOFF_VERSION, path: '/users/7', data: [{ id: '7', from: 'build' }], static: true };
        await withRouter(seededRoutes(() => runs++), '/users/7', async (router) =>
        {
            expect(router.loaders[0]!.data()).toEqual({ id: '7', from: 'build' });
            await flush();
            await flush();
            expect(runs).toBe(0);
        }, seed);
    });

    it('a seed past the freshness bound serves synchronously, then heals exactly once', async () =>
    {
        let runs = 0;
        const seed = { version: LOADER_HANDOFF_VERSION, path: '/users/7', data: [{ id: '7', from: 'stale-page-cache' }], at: Date.now() - 60_000 };
        await withRouter(seededRoutes(() => runs++), '/users/7', async (router) =>
        {
            // Served synchronously despite its age - SWR, not a loading flash.
            expect(router.loaders[0]!.data()).toEqual({ id: '7', from: 'stale-page-cache' });
            expect(router.loaders[0]!.loading()).toBe(false);
            await flush();
            await flush();
            // The one background heal replaced it.
            expect(runs).toBe(1);
            expect(router.loaders[0]!.data()).toEqual({ id: '7', from: 'network' });
        }, seed);
    });

    it('a v2 payload is rejected cleanly: the client fetches fresh', async () =>
    {
        let runs = 0;
        const seed = { version: 2, path: '/users/7', data: [{ id: '7', from: 'old-server' }] };
        await withRouter(seededRoutes(() => runs++), '/users/7', async (router) =>
        {
            await flush();
            expect(runs).toBe(1);
            expect(router.loaders[0]!.data()).toEqual({ id: '7', from: 'network' });
        }, seed);
    });
});

describe('seeded parent edges', () =>
{
    it('a parent refetch after hydration re-runs the SEEDED child with the fresh parent', async () =>
    {
        let parentRuns = 0;
        let childRuns = 0;
        const routes: Route[] =
        [{
            path: '/org',
            component: leaf,
            loader: async () =>
            {
                parentRuns += 1;
                return { org: `net-${ parentRuns + 1 }` };
            },
            children:
            [{
                path: ':id',
                component: leaf,
                loader: async ({ params, parent }) =>
                {
                    childRuns += 1;
                    return `${ ((await parent) as { org: string }).org }:${ params.id }`;
                }
            }]
        }];
        const seed = {
            version: LOADER_HANDOFF_VERSION,
            path: '/org/1',
            data: [{ org: 'net-1' }, 'net-1:1'],
            at: Date.now()
        };
        await withRouter(routes, '/org/1', async (router) =>
        {
            expect(router.loaders[1]!.data()).toBe('net-1:1'); // adopted, zero fetches
            expect(childRuns).toBe(0);

            await router.loaders[0]!.refetch();
            await flush();
            await flush();
            // The seeded child carried the parent edge: the renewal reached it and it
            // re-ran against the FRESH parent value, never left deriving from the old one.
            expect(parentRuns).toBe(1);
            expect(childRuns).toBe(1);
            expect(router.loaders[1]!.data()).toBe('net-2:1');
        }, seed);
    });

    it('a NEGATIVE-age seed (client clock behind the server) adopts fresh', async () =>
    {
        let runs = 0;
        const routes: Route[] =
        [{
            path: '/n',
            component: leaf,
            loader: async () =>
            {
                runs += 1;
                return 'network';
            }
        }];
        const seed = { version: LOADER_HANDOFF_VERSION, path: '/n', data: ['seeded'], at: Date.now() + 120_000 };
        await withRouter(routes, '/n', async (router) =>
        {
            expect(router.loaders[0]!.data()).toBe('seeded');
            await flush();
            await flush();
            expect(runs).toBe(0); // skew never manufactures a refetch
        }, seed);
    });
});

describe('root-first ordering across parent swaps', () =>
{
    it('navigating between chains with DIFFERENT parents hands each child ITS parent\'s value', async () =>
    {
        const routes: Route[] =
        [
            {
                path: '/a',
                component: leaf,
                loader: async () => 'parent-a',
                children: [{
                    path: 'x',
                    component: leaf,
                    loader: async ({ parent }) => `x-under-${ String(await parent) }`
                }]
            },
            {
                path: '/b',
                component: leaf,
                loader: async () => 'parent-b',
                children: [{
                    path: 'y',
                    component: leaf,
                    loader: async ({ parent }) => `y-under-${ String(await parent) }`
                }]
            }
        ];
        await withRouter(routes, '/a/x', async (router) =>
        {
            await flush();
            expect(router.loaders[1]!.data()).toBe('x-under-parent-a');

            router.navigate('/b/y');
            await flush();
            // Both levels re-keyed at once; root-first staging means the child's await
            // found ITS parent already fetching - never the previous chain's value.
            expect(router.loaders[1]!.data()).toBe('y-under-parent-b');
        });
    });
});

describe('lazy chunk retry', () =>
{
    it('a failed chunk load retries on the next demand instead of poisoning the route', async () =>
    {
        let attempts = 0;
        const route: Route = {
            path: '/lazy',
            lazy: async () =>
            {
                attempts += 1;
                if (attempts === 1)
                {
                    throw new Error('network down');
                }
                return leaf;
            }
        };
        const { resolveRouteComponent } = await import('azerothjs');
        await expect((resolveRouteComponent as (r: Route) => Promise<unknown>)(route)).rejects.toThrow('network down');
        await expect((resolveRouteComponent as (r: Route) => Promise<unknown>)(route)).resolves.toBe(leaf);
        expect(attempts).toBe(2);
    });
});

describe('navigation over retained entries', () =>
{
    it('returning to a left route serves its cached data synchronously and revalidates behind', async () =>
    {
        let aRuns = 0;
        const routes: Route[] =
        [
            { path: '/a', component: leaf, loader: async () =>
            {
                aRuns += 1;
                return `a-${ aRuns }`;
            } },
            { path: '/b', component: leaf, loader: async () => 'b' }
        ];
        await withRouter(routes, '/a', async (router) =>
        {
            await flush();
            expect(router.loaders[0]!.data()).toBe('a-1');

            router.navigate('/b');
            await flush();
            expect(router.loaders[0]!.data()).toBe('b');

            router.navigate('/a');
            // The retained entry serves synchronously - no loading flash on return.
            expect(router.loaders[0]!.data()).toBe('a-1');
            expect(router.loaders[0]!.loading()).toBe(false);
            await flush();
            await flush();
            // One background revalidation brought it current.
            expect(aRuns).toBe(2);
            expect(router.loaders[0]!.data()).toBe('a-2');
        });
    });
});

// The staged loader trigger is owned by the cache entry that will be fetched with it, so it
// dies with that entry instead of living in a second, never-pruned map keyed per URL. The
// arms below pin the two seams that lifetime creates: a parent whose entry is gone can no
// longer be resurrected (it has nothing to fetch WITH), and the cache-disabled path has no
// entry to hang a trigger on at all.
describe('the loader trigger lives and dies with its cache entry', () =>
{
    it('resolves a vanished parent as undefined instead of throwing the internal never-staged error', async () =>
    {
        const seen: unknown[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const routes: Route[] = [{
            path: '/p/:id',
            component: leaf,
            loader: () => Promise.resolve('parent-value'),
            children: [{
                path: 'child',
                component: leaf,
                // Awaits its parent LATE - after the parent's entry is gone. Before the
                // trigger was entry-owned this refetched through the leaked map; the naive
                // bounded version threw '[azerothjs/router] internal: ... never staged'.
                loader: async ({ parent }) =>
                {
                    await gate;
                    try
                    {
                        seen.push({ ok: await parent });
                    }
                    catch (error)
                    {
                        seen.push({ failed: String(error) });
                    }
                    return 'child-value';
                }
            }]
        }];

        await withRouter(routes, '/p/1/child', async () =>
        {
            await flush();
            // Drop every entry, which is what an eviction past the retain window does.
            resetDataCache();
            release();
            await flush();
            await flush();
        });

        expect(seen).toHaveLength(1);
        expect(JSON.stringify(seen[0])).not.toContain('never staged');
        expect(seen[0]).toEqual({ ok: undefined });
    });

    it('still runs loaders when there is NO cache to carry the trigger', async () =>
    {
        // A latched server at the default scope, a released scope, and a DOM test after a
        // server entry point ran all reach getDataCache() === null. There the resource
        // calls the fetcher directly, and the one-frame handoff is the only carrier.
        resetDataCache();
        const { latchServerData } = await import('azerothjs/internal');
        latchServerData();
        try
        {
            const values: unknown[] = [];
            await withRouter(
                [{ path: '/n/:id', component: leaf, loader: ({ params }) => Promise.resolve(`v:${ params.id }`) }],
                '/n/7',
                async (router) =>
                {
                    await flush();
                    values.push(router.loaders[0]?.data());
                    router.navigate('/n/8');
                    await flush();
                    values.push(router.loaders[0]?.data());
                });
            expect(values).toEqual(['v:7', 'v:8']);
        }
        finally
        {
            resetDataCache();
        }
    });
});

// The identity violation itself, not the shape difference: an SSR-produced value is seeded
// into the entry and ADOPTED WITHOUT FETCHING, and a later navigation that leaves the level
// key unchanged starts no fetch at all. So if the server computed that value from inputs
// WIDER than the key, those bytes serve every other URL sharing the key - permanently, not
// for a frame. The loader returns its own query, so the served value is a literal witness of
// the argument the producing path used.
describe('an SSR seed is the preimage of the key it is stored under', () =>
{
    const declaredRoutes = (): Route[] =>
    {
        return [{
            path: '/items',
            component: leaf,
            search: {
                safeParse: (value: unknown) =>
                {
                    const query = value as Record<string, string | undefined>;
                    return { ok: true as const, value: { page: query.page ?? '1' } };
                }
            },
            loader: ({ query }) => Promise.resolve(query)
        }];
    };

    it('serves a seed produced under one undeclared param to a URL carrying another', async () =>
    {
        // Produced on the server for utm=junk; the key names only `page`.
        const handoff = await matchAndLoad(declaredRoutes(), '/items?page=1&utm=junk');
        expect(handoff).not.toBeNull();

        await withRouter(declaredRoutes(), '/items?page=1&utm=junk', async (router) =>
        {
            await flush();
            // The adopted value must be the key's preimage - the declared subset alone.
            expect(router.loaders[0]!.data()).toEqual({ page: '1' });

            // A different undeclared param shares the key, so NO fetch runs and this value
            // is served as-is. That is only sound because it contains nothing about `utm`.
            router.navigate('/items?page=1&utm=other');
            await flush();
            expect(router.loaders[0]!.data()).toEqual({ page: '1' });
        }, handoff);
    });

    it('CONTROL: when the param IS declared, the two URLs are different keys and refetch', async () =>
    {
        // Without this the arm above would pass against a build that keys on nothing at all.
        let runs = 0;
        const routes: Route[] =
        [{
            path: '/items',
            component: leaf,
            search: {
                safeParse: (value: unknown) =>
                {
                    const query = value as Record<string, string | undefined>;
                    return { ok: true as const, value: { page: query.page ?? '1', utm: query.utm ?? '' } };
                }
            },
            loader: ({ query }) =>
            {
                runs += 1;
                return Promise.resolve(query);
            }
        }];
        await withRouter(routes, '/items?page=1&utm=junk', async (router) =>
        {
            await flush();
            expect(runs).toBe(1);
            router.navigate('/items?page=1&utm=other');
            await flush();
            expect(runs).toBe(2);
            expect(router.loaders[0]!.data()).toEqual({ page: '1', utm: 'other' });
        });
    });
});
