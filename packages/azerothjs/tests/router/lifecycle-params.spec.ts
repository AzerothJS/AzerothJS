// @vitest-environment happy-dom
//
// Bare composables resolve their own level in slot-effect re-run builds, and params
// guarding: a retained layout never observes a vetoed target's params, the async BOOT
// guard renders params as {}, and a guard's from.params is the screen actually being
// left (the accept-snapshot composition).
import { describe, it, expect } from 'vitest';
import { createEffect, h, render } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet, useParams, useLoader, useSearch } from 'azerothjs';
import type { Route, Router, MountNode, Params } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mountApp(routes: Route[], initialUrl: string): { router: Router; container: HTMLElement; cleanup: () => void }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        return h('div', { id: 'app' }, Routes({ router }));
    }, container);
    return {
        router,
        container,
        cleanup: (): void =>
        {
            render(() => h('div', {}), container);
            container.remove();
        }
    };
}

describe('bare composables in slot-effect re-run builds', () =>
{
    it('bare useLoader() reads its OWN level after an own-param remount and an index<->param swap', async () =>
    {
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, Outlet({ children: props.children }));

        // Both the index child and the param child read their loader BARE - the
        // construction-frozen level index must point at each segment's own level even
        // when the segment was built by a slot-effect RE-RUN, not the initial chain walk.
        const IndexChild = (): HTMLElement =>
        {
            const data = useLoader<string>();
            return h('ul', { id: 'index' }, () => data.data() ?? 'loading');
        };
        const ParamChild = (): HTMLElement =>
        {
            const data = useLoader<string>();
            return h('span', { id: 'param' }, () => data.data() ?? 'loading');
        };

        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            loader: async () => 'layout-data',
            children:
            [
                { path: '', component: IndexChild, loader: async () => 'index-data' },
                { path: ':id', component: ParamChild, loader: async ({ params }) => `leaf-${ params.id }` }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users');
        await flush();
        expect(container.querySelector('#index')!.textContent).toBe('index-data');

        // Slot-effect re-run: index -> param under the retained layout.
        router.navigate('/users/1');
        await flush();
        expect(container.querySelector('#param')!.textContent).toBe('leaf-1');

        // Slot-effect re-run: own-param remount.
        router.navigate('/users/2');
        await flush();
        expect(container.querySelector('#param')!.textContent).toBe('leaf-2');

        // Slot-effect re-run: param -> index, back again.
        router.navigate('/users');
        await flush();
        expect(container.querySelector('#index')!.textContent).toBe('index-data');
        cleanup();
    });

    it('bare useLoader() falls back to the nearest loading ancestor from a loaderless re-run leaf', async () =>
    {
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, Outlet({ children: props.children }));
        const Plain = (): HTMLElement =>
        {
            const data = useLoader<string>();
            return h('em', { id: 'plain' }, () => data.data() ?? 'loading');
        };

        const routes: Route[] =
        [{
            path: '/site',
            component: Layout,
            loader: async () => 'site-data',
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'home' }, 'home') },
                { path: 'about', component: Plain }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/site');
        await flush();

        router.navigate('/site/about');
        await flush();
        expect(container.querySelector('#plain')!.textContent).toBe('site-data');
        cleanup();
    });

    it('bare useSearch() tracks the query from a re-run-built leaf', async () =>
    {
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, Outlet({ children: props.children }));
        const SearchLeaf = (): HTMLElement =>
        {
            const search = useSearch();
            return h('span', { id: 'sleaf' }, () =>
            {
                const q = search().q;
                return typeof q === 'string' ? q : 'none';
            });
        };

        const routes: Route[] =
        [{
            path: '/shop',
            component: Layout,
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'home' }, 'home') },
                { path: 'search', component: SearchLeaf }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/shop');

        // The leaf below is built by a slot-effect re-run, not the initial walk.
        router.navigate('/shop/search?q=boots');
        expect(container.querySelector('#sleaf')!.textContent).toBe('boots');

        router.navigate('/shop/search?q=hats');
        expect(container.querySelector('#sleaf')!.textContent).toBe('hats');
        cleanup();
    });
});

describe('params guarding', () =>
{
    it('(a) a retained layout observes the OLD params for the whole async-guard hold; the vetoed target params never surface', async () =>
    {
        let releaseGuard!: (verdict: boolean) => void;
        const paramValuesSeen: string[] = [];

        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            const params = useParams();
            createEffect(() =>
            {
                paramValuesSeen.push(String(params().id));
            });
            return h('div', { id: 'layout' }, Outlet({ children: props.children }));
        };

        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            children:
            [{
                path: ':id',
                component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf'),
                guard: ({ params }): Promise<boolean> =>
                {
                    // Only the SECOND navigation holds; the boot passes through.
                    if (params.id === '1')
                    {
                        return Promise.resolve(true);
                    }
                    return new Promise((resolve) =>
                    {
                        releaseGuard = resolve;
                    });
                }
            }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        await flush();
        expect(paramValuesSeen).toEqual(['1']);

        router.navigate('/users/2');
        await flush();
        // The hold: pending() is honest, and the layout still sees the OLD params.
        expect(router.pending()).toBe(true);
        expect(paramValuesSeen).toEqual(['1']);

        releaseGuard(false);
        await flush();
        // Vetoed: the navigation settles at the target in the blocked state, so the layout is
        // torn down - but the target's params still never reached any public spelling, which
        // is what this test is for.
        expect(paramValuesSeen).not.toContain('2');
        expect(router.state()).toEqual({ kind: 'blocked', status: 403 });
        expect(router.location().pathname).toBe('/users/2');
        expect(router.location().params).toEqual({});
        expect(container.querySelector('#layout')).toBeNull();
        cleanup();
    });

    it('(b) under an async BOOT guard, useParams() and location().params are {} while pathname already shows the URL', async () =>
    {
        let releaseGuard!: (verdict: boolean) => void;
        const routes: Route[] =
        [{
            path: '/users/:id',
            component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf'),
            guard: (): Promise<boolean> => new Promise((resolve) =>
            {
                releaseGuard = resolve;
            })
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/7');

        // The boot hold: raw URL truth leads; params are MATCH OUTPUT and stay empty.
        expect(router.location().pathname).toBe('/users/7');
        expect(router.location().params).toEqual({});
        expect(useParams(router)()).toEqual({});
        expect(container.querySelector('#leaf')).toBeNull();

        releaseGuard(true);
        await flush();
        expect(router.location().params).toEqual({ id: '7' });
        expect(useParams(router)()).toEqual({ id: '7' });
        expect(container.querySelector('#leaf')).not.toBeNull();
        cleanup();
    });

    it('(c) across two consecutive navigations a guard sees from.params of the screen actually being left', async () =>
    {
        const fromParamsSeen: Array<Params | null> = [];
        const routes: Route[] =
        [{
            path: '/u/:id',
            component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf'),
            guard: ({ from }): boolean =>
            {
                fromParamsSeen.push(from === null ? null : { ...from.params });
                return true;
            }
        }];
        const { router, cleanup } = mountApp(routes, '/u/1');
        await flush();

        router.navigate('/u/2');
        await flush();
        router.navigate('/u/3');
        await flush();

        // Boot: nothing left. Then each navigation's from is EXACTLY the previous screen.
        // Under the stale composition (accept() reading location() one line before
        // setMatch), the second entry would still be {id:'1'} - one navigation behind.
        expect(fromParamsSeen).toEqual([null, { id: '1' }, { id: '2' }]);
        cleanup();
    });
});
