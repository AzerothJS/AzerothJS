// The router-v2 core (unit 5.2): per-level PARALLEL loaders with the opt-in `parent`
// sequencing, lazy route chunks (boot validation, no-flash hold, load-error surfacing),
// router.pending(), <RouterProvider> context resolution, defineRoute typed handles, and
// schema-validated search params. Real promises, memory history, createRoot scoping -
// the same harness discipline as the v1 specs.
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { object, number, string, enumOf } from '@azerothjs/schema';

/**
 * True when a query read carries NOTHING readable.
 *
 * Under the repo's `noUncheckedIndexedAccess`, a broken search guard collapses a schema-less
 * route's query to `Record<string, never>`, and indexing that yields `undefined` rather than
 * `never` - so an `IsNever` check reads false and asserts nothing. This is the shape that
 * actually discriminates.
 */
type IsUnreadable<T> = [T] extends [undefined] ? true : false;
import {
    createRoot, render, h,
    createRouter, createMemoryHistory, defineRoute,
    RouterProvider, Routes, useRoute, useParams, useLoader, useSearch,
    matchAndLoad, LOADER_HANDOFF_VERSION
} from 'azerothjs';
import type { Route, Router } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void> | void): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
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

describe('per-level parallel loaders', () =>
{
    it('EVERY matched level loads, all levels starting together (no waterfall)', async () =>
    {
        const starts: string[] = [];
        const routes: Route[] = [{
            path: '/shop',
            component: leaf,
            loader: async () =>
            {
                starts.push('layout'); return 'layout-data';
            },
            children: [{
                path: 'items/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    starts.push('leaf'); return `item-${ params.id }`;
                }
            }]
        }];
        await withRouter(routes, '/shop/items/7', async (router) =>
        {
            // Both fetchers started in the same tick - parallel by construction.
            expect(starts).toEqual(['layout', 'leaf']);
            expect(router.loaders[0]!.loading()).toBe(true);
            expect(router.loaders[1]!.loading()).toBe(true);
            await flush();
            expect(router.loaders[0]!.data()).toBe('layout-data');
            expect(router.loaders[1]!.data()).toBe('item-7');
        });
    });

    it('`parent` resolves with the nearest ANCESTOR loader data - opt-in sequencing', async () =>
    {
        const routes: Route[] = [{
            path: '/a',
            component: leaf,
            loader: async () => 'root-data',
            children: [{
                path: 'b',
                component: leaf, // no loader at this middle level
                children: [{
                    path: 'c',
                    component: leaf,
                    loader: async ({ parent }) => `child-of-${ String(await parent) }`
                }]
            }]
        }];
        await withRouter(routes, '/a/b/c', async (router) =>
        {
            await flush();
            expect(router.loaders[2]!.data()).toBe('child-of-root-data'); // skipped the loaderless middle
        });
    });

    it('router.pending() covers the in-flight window and settles', async () =>
    {
        const routes: Route[] = [{ path: '/p', component: leaf, loader: async () => 'x' }];
        await withRouter(routes, '/p', async (router) =>
        {
            expect(router.pending()).toBe(true);
            await flush();
            expect(router.pending()).toBe(false);
        });
    });

    it('a navigation re-runs each level loader with the new params, in parallel again', async () =>
    {
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/users/:id', component: leaf,
            loader: async ({ params }) =>
            {
                seen.push(params.id ?? ''); return params.id;
            }
        }];
        await withRouter(routes, '/users/1', async (router) =>
        {
            await flush();
            router.navigate('/users/2');
            await flush();
            expect(seen).toEqual(['1', '2']);
            expect(router.loaders[0]!.data()).toBe('2');
        });
    });
});

describe('lazy routes', () =>
{
    it('boot validation: a route with BOTH component and lazy (or neither) fails loudly', () =>
    {
        createRoot(() =>
        {
            expect(() => createRouter({
                routes: [{ path: '/x', component: leaf, lazy: async () => leaf }],
                history: createMemoryHistory('/')
            })).toThrow(/exactly one/);
            expect(() => createRouter({
                routes: [{ path: '/x' }],
                history: createMemoryHistory('/')
            })).toThrow(/exactly one/);
        });
    });

    it('the chunk resolves on match and chainReady flips; pending covers the download', async () =>
    {
        let releaseChunk!: (value: { default: () => HTMLElement }) => void;
        const chunk = new Promise<{ default: () => HTMLElement }>((resolve) =>
        {
            releaseChunk = resolve;
        });
        const routes: Route[] = [{ path: '/lazy', lazy: () => chunk }];
        await withRouter(routes, '/lazy', async (router) =>
        {
            expect(router.chainReady()).toBe(false);
            expect(router.pending()).toBe(true);
            releaseChunk({ default: leaf });
            await flush();
            expect(router.chainReady()).toBe(true);
            expect(router.pending()).toBe(false);
        });
    });

    it('<Routes> holds the CURRENT screen until the chunk lands - no empty flash', async () =>
    {
        let releaseChunk!: (value: { default: () => HTMLElement }) => void;
        const chunk = new Promise<{ default: () => HTMLElement }>((resolve) =>
        {
            releaseChunk = resolve;
        });
        const home = (): HTMLElement =>
        {
            const el = document.createElement('div'); el.textContent = 'home'; return el;
        };
        const lazyPage = (): HTMLElement =>
        {
            const el = document.createElement('div'); el.textContent = 'lazy-page'; return el;
        };

        const host = document.createElement('div');
        let router!: Router;
        render(() =>
        {
            router = createRouter({
                routes: [{ path: '/', component: home }, { path: '/lazy', lazy: () => chunk }],
                history: createMemoryHistory('/')
            });
            return Routes({ router });
        }, host);
        try
        {
            await flush();
            expect(host.textContent).toContain('home');

            router.navigate('/lazy');
            await flush();
            expect(host.textContent).toContain('home'); // held - chunk still downloading

            releaseChunk({ default: lazyPage });
            await flush();
            expect(host.textContent).toContain('lazy-page');
        }
        finally
        {
            render(() => document.createElement('span'), host); // dispose the mounted tree
        }
    });

    it('matchAndLoad pre-resolves lazy chunks server-side (the sync SSR render finds them)', async () =>
    {
        const routes: Route[] = [{
            path: '/lazy', lazy: async () => ({ default: leaf }), loader: async () => 'lazy-data'
        }];
        const handoff = await matchAndLoad(routes, new URL('http://local/lazy'));
        expect(handoff).toEqual({ version: LOADER_HANDOFF_VERSION, path: '/lazy', data: ['lazy-data'] });
    });
});

describe('RouterProvider context resolution', () =>
{
    it('composables resolve the provided router with no argument; explicit stays as override', async () =>
    {
        const host = document.createElement('div');
        let seenPath = '';
        let seenId = '';
        const page = (): HTMLElement =>
        {
            const location = useRoute();            // no router argument
            const params = useParams();
            seenPath = location().pathname;
            seenId = params().id ?? '';
            return leaf();
        };
        render(() =>
        {
            const router = createRouter({
                routes: [{ path: '/users/:id', component: page }],
                history: createMemoryHistory('/users/9')
            });
            return RouterProvider({ router, children: () => Routes({}) });
        }, host);
        try
        {
            await flush();
            expect(seenPath).toBe('/users/9');
            expect(seenId).toBe('9');
        }
        finally
        {
            render(() => document.createElement('span'), host); // dispose the mounted tree
        }
    });

    it('no provider and no argument is a loud, named error', () =>
    {
        createRoot(() =>
        {
            expect(() => useRoute()).toThrow(/useRoute\(\).*RouterProvider/s);
        });
    });

    it('useLoader() inside a route component resolves ITS OWN level (nearest-with-loader)', async () =>
    {
        const host = document.createElement('div');
        let layoutResource!: ReturnType<typeof useLoader>;
        let childResource!: ReturnType<typeof useLoader>;
        const layout = (props: { children?: unknown }): HTMLElement =>
        {
            layoutResource = useLoader();
            // Children are placed through h() (a supported writer): under the
            // per-segment route tree `children` is a slot HANDLE, not a Node, and a
            // layout that never places it constructs nothing deeper.
            return h('section', {}, props.children as never);
        };
        const child = (): HTMLElement =>
        {
            // This leaf has NO loader: nearest ancestor with one is the layout.
            childResource = useLoader();
            return leaf();
        };
        render(() =>
        {
            const router = createRouter({
                routes: [{
                    path: '/l', component: layout, loader: async () => 'layout-data',
                    children: [{ path: 'c', component: child }]
                }],
                history: createMemoryHistory('/l/c')
            });
            return Routes({ router });
        }, host);
        try
        {
            await flush();
            expect(layoutResource.data()).toBe('layout-data');
            expect(childResource.data()).toBe('layout-data');
        }
        finally
        {
            render(() => document.createElement('span'), host); // dispose the mounted tree
        }
    });
});

describe('defineRoute typed handles', () =>
{
    const userRoute = defineRoute('/users/:id', {
        component: leaf,
        loader: async ({ params }) => ({ id: params.id, name: `user-${ params.id }` }),
        search: object({ tab: enumOf(['posts', 'bio']).optional(), page: number({ coerce: true }).optional() })
    });

    it('is a real Route: createRouter mounts it and its loader runs', async () =>
    {
        await withRouter([userRoute], '/users/5', async (router) =>
        {
            await flush();
            expect(router.loaders[0]!.data()).toEqual({ id: '5', name: 'user-5' });
        });
    });

    it('.to() builds the typed target: substitution, encoding, search serialization', () =>
    {
        expect(userRoute.to({ id: '42' })).toEqual({ pathname: '/users/42' });
        expect(userRoute.to({ id: 'a b' })).toEqual({ pathname: '/users/a%20b' });
        expect(userRoute.to({ id: '1' }, { search: { tab: 'bio', page: 2 }, hash: 'top' }))
            .toEqual({ pathname: '/users/1', query: { tab: 'bio', page: '2' }, hash: 'top' });

        // Type-level: params are pattern-checked; search is schema-checked.
        expectTypeOf(userRoute.to).parameter(0).toExtend<{ id: string }>();
        expectTypeOf<{ id: string }>().toExtend<Parameters<typeof userRoute.to>[0]>();
        // @ts-expect-error - 'nope' is not a declared search key
        void userRoute.to({ id: '1' }, { search: { nope: true } });
        const staticRoute = defineRoute('/about', { component: leaf });
        expect(staticRoute.to()).toEqual({ pathname: '/about' });
    });

    it('a SCHEMA-LESS route hands its loader the raw query, not a never-typed one', () =>
    {
        // The guard used to read `[Search] extends [never]`, but the default is
        // `Record<string, never>`, which does not extend `never` - so the branch was
        // unreachable and every query read typed as `never`. That failed SILENTLY: `never`
        // assigns to anything, so nothing errored at the read; it propagated into whatever the
        // loader built and poisoned the handle's inferred Data, while the runtime handed over
        // the raw query all along.
        const listRoute = defineRoute('/list', {
            component: leaf,
            loader: ({ query }) =>
            {
                // A plain conditional type, NOT expectTypeOf: vitest's matcher accepted the
                // broken shape, so it was no assertion at all. This one is checked by the
                // repo's own `npm run typecheck` - with the guard broken the read is
                // `undefined` and assigning `false` is TS2322.
                const queryIsUsable: IsUnreadable<typeof query.page> = false;
                void queryIsUsable;
                return Promise.resolve(query.page);
            }
        });
        expect(listRoute.path).toBe('/list');

        // CONTROL: a DECLARED schema still narrows, rather than widening back to a raw query.
        const searchRoute = defineRoute('/find', {
            component: leaf,
            search: object({ term: string() }),
            loader: ({ query }) =>
            {
                const termIsTyped: IsUnreadable<typeof query.term> = false;
                void termIsTyped;
                expectTypeOf(query.term).toEqualTypeOf<string>();
                return Promise.resolve(query.term);
            }
        });
        expect(searchRoute.path).toBe('/find');
    });

    it('.to() on a relative (nested-child) pattern refuses - it cannot address a navigation', () =>
    {
        const relative = defineRoute('settings', { component: leaf });
        expect(() => relative.to()).toThrow(/ABSOLUTE/);
    });

    it('useLoader(handle) is typed by the loader and reads that level', async () =>
    {
        await withRouter([userRoute], '/users/3', async (router) =>
        {
            const data = useLoader(userRoute, router);
            expectTypeOf(data.data).toEqualTypeOf<() => { id: string; name: string } | undefined>();
            await flush();
            expect(data.data()).toEqual({ id: '3', name: 'user-3' });
        });
    });

    it('useSearch(handle) validates, COERCES, and types the query', async () =>
    {
        await withRouter([userRoute], '/users/1?tab=bio&page=4&junk=x', async (router) =>
        {
            const search = useSearch(userRoute, router);
            expectTypeOf(search).returns.toExtend<{ tab?: 'posts' | 'bio' | undefined; page?: number | undefined }>();
            expect(search()).toEqual({ tab: 'bio', page: 4 }); // page COERCED to number, junk stripped
        });
    });

    it('an invalid query degrades to {} with ONE console warning, never a crash', async () =>
    {
        const strict = defineRoute('/s', { component: leaf, search: object({ n: number({ coerce: true }) }) });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            await withRouter([strict], '/s?n=not-a-number', async (router) =>
            {
                const search = useSearch(strict, router);
                expect(search()).toEqual({});
                expect(search()).toEqual({});
                expect(warn).toHaveBeenCalledTimes(1); // once per offending query string
            });
        }
        finally
        {
            warn.mockRestore();
        }
    });
});
