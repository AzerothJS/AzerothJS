// @vitest-environment happy-dom
//
// The P0-3 router cluster: three defects that all present as "navigation does not update the
// right thing", with three different causes. Each test below was observed FAILING on the tree
// before its fix, and the query case carries a param-change control so a harness that cannot
// drive loaders at all cannot be mistaken for a passing fix.
import { describe, it, expect } from 'vitest';
import { createRoot, h, render, createRouter, createMemoryHistory, Routes, Outlet, type MountNode } from 'azerothjs';
import type { Route, RouteLoaderArgs, Router, RouterConfig } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs `fn` with a router owned by a root, then disposes it. */
async function withRouter(config: RouterConfig, fn: (router: Router) => Promise<void>): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter(config);
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

describe('a query-only navigation re-runs loaders', () =>
{
    it('delivers the new query to the loader', async () =>
    {
        // `query` is part of the documented loader arguments, but the loader resource keyed
        // only on `match` - a structural memo over the matched chain, deliberately blind to
        // the query - so ?q=a -> ?q=b never re-evaluated the source and the loader never ran
        // again. A search page could not load its own search.
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/search',
            component: (): HTMLElement => h('div', {}, 'search'),
            loader: async (args: RouteLoaderArgs): Promise<string> =>
            {
                seen.push(String(args.query.q));
                return 'x';
            }
        }];

        await withRouter({ routes, history: createMemoryHistory('/search?q=a') }, async (router) =>
        {
            await flush();
            router.navigate('/search?q=b');
            await flush();
            router.navigate('/search?q=c');
            await flush();
        });

        expect(seen).toEqual(['a', 'b', 'c']);
    });

    it('CONTROL: a param change re-runs the loader', async () =>
    {
        // Passed before the fix too. Here so a broken loader harness cannot masquerade as a
        // passing query fix.
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/u/:id',
            component: (): HTMLElement => h('div', {}, 'u'),
            loader: async (args: RouteLoaderArgs): Promise<string> =>
            {
                seen.push(String(args.params.id));
                return 'x';
            }
        }];

        await withRouter({ routes, history: createMemoryHistory('/u/1') }, async (router) =>
        {
            await flush();
            router.navigate('/u/2');
            await flush();
        });

        expect(seen).toEqual(['1', '2']);
    });

    it('does not re-run the loader for a hash-only change', async () =>
    {
        // The fix tracks the search string through a memo rather than the whole location, so
        // equal strings do not propagate and a hash change stays cosmetic.
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/search',
            component: (): HTMLElement => h('div', {}, 'search'),
            loader: async (): Promise<string> =>
            {
                seen.push('run');
                return 'x';
            }
        }];

        await withRouter({ routes, history: createMemoryHistory('/search?q=a') }, async (router) =>
        {
            await flush();
            router.navigate('/search?q=a#section');
            await flush();
        });

        expect(seen).toEqual(['run']);
    });
});

describe('a guard veto restores the previous URL exactly', () =>
{
    it('does not double-apply the base prefix', async () =>
    {
        // The accepted path was stored base-PREFIXED and then fed back through
        // performNavigate, which applies the prefix itself: a veto under base '/app' wrote
        // '/app/app/other' into history, which the router read back as '/app/other'. Every
        // later link then resolved against a path one level too deep.
        let guardRuns = 0;
        const routes: Route[] = [
            { path: '/', component: (): HTMLElement => h('div', {}, 'home') },
            { path: '/other', component: (): HTMLElement => h('div', {}, 'other') },
            {
                path: '/secret',
                component: (): HTMLElement => h('div', {}, 'secret'),
                guard: (): boolean =>
                {
                    guardRuns += 1;
                    return false;
                }
            }
        ];

        await withRouter({ routes, base: '/app', history: createMemoryHistory('/app/') }, async (router) =>
        {
            await flush();
            router.navigate('/other');
            await flush();
            const accepted = router.location().pathname;

            router.navigate('/secret');
            await flush();

            // The guard really ran; otherwise this asserts nothing.
            expect(guardRuns).toBeGreaterThan(0);
            expect(accepted).toBe('/other');
            expect(router.location().pathname).toBe('/other');
        });
    });
});

describe('layout identity across a param change', () =>
{
    // THE ACCEPTANCE TEST for layout retention. Formerly the tree's one
    // `it.fails`: renderChain built the whole chain eagerly leaf-to-root, so any match
    // change re-invoked every layout. Under the per-segment route tree, a leaf `:id`
    // change rebuilds the leaf's slot only - the layout's component body does not
    // re-execute and its element identity survives.
    it('keeps the layout element when only the leaf param changes', async () =>
    {
        let layoutBuilds = 0;
        const routes: Route[] = [{
            path: '/users',
            component: (props: { children?: MountNode | undefined }): MountNode =>
            {
                layoutBuilds += 1;
                return h('div', { id: 'layout' }, Outlet({ children: props.children }));
            },
            children: [{ path: ':id', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/users/1') });
            return h('div', {}, Routes({ router }));
        }, container);
        await flush();

        const buildsBefore = layoutBuilds;
        router.navigate('/users/2');
        await flush();

        expect(layoutBuilds).toBe(buildsBefore);
    });
});
