// @vitest-environment happy-dom
//
// The layout-identity matrix, the param-remount contract, veto, and redirects. The per-segment route tree's core
// claim: a navigation rebuilds exactly the segments whose identity changed (route object at
// that level, or the params its OWN pattern binds) and retains every ancestor - same element,
// no component-body re-execution. Build COUNTERS are the oracle for bodies; element reference
// equality is the oracle for DOM.
import { describe, it, expect, beforeEach } from 'vitest';
import { createSignal, createEffect, onCleanup, h, render } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet, useParams, redirect } from 'azerothjs';
import type { Route, RouteComponent, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Per-test construction counters, reset in beforeEach. */
const counts = { l0: 0, l1: 0, leaf: 0, other: 0 };

const L0 = (props: { children?: MountNode | undefined }): MountNode =>
{
    counts.l0 += 1;
    return h('div', { id: 'l0' }, Outlet({ children: props.children }));
};
const L1 = (props: { children?: MountNode | undefined }): MountNode =>
{
    counts.l1 += 1;
    return h('section', { id: 'l1' }, Outlet({ children: props.children }));
};
const Leaf = (): HTMLElement =>
{
    counts.leaf += 1;
    return h('span', { id: 'leaf' }, 'leaf');
};

/** The 3-level chain: /a/:aid/b/:bid/c/:cid with a param bound at every level. */
const chainRoutes = (): Route[] =>
    [{
        path: '/a/:aid',
        component: L0,
        children:
    [{
        path: 'b/:bid',
        component: L1,
        children: [{ path: 'c/:cid', component: Leaf }]
    }]
    }];

function mountApp(routes: Route[], initialUrl: string, fallback?: () => HTMLElement): { router: Router; container: HTMLElement; cleanup: () => void }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        return h('div', { id: 'app' }, Routes({ router, fallback }));
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

beforeEach(() =>
{
    counts.l0 = 0;
    counts.l1 = 0;
    counts.leaf = 0;
    counts.other = 0;
});

describe('layout-identity matrix (3-level chain)', () =>
{
    it('(a) a leaf param change retains levels 0-1 and rebuilds only the leaf', () =>
    {
        const { router, container, cleanup } = mountApp(chainRoutes(), '/a/1/b/1/c/1');
        const l0 = container.querySelector('#l0');
        const l1 = container.querySelector('#l1');
        const leafBefore = container.querySelector('#leaf');
        expect(leafBefore).not.toBeNull();
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 1 });

        router.navigate('/a/1/b/1/c/2');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#l1')).toBe(l1);
        expect(container.querySelector('#leaf')).not.toBe(leafBefore);
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 2 });
        cleanup();
    });

    it('(b) a middle param change retains level 0 and rebuilds levels 1-2', () =>
    {
        const { router, container, cleanup } = mountApp(chainRoutes(), '/a/1/b/1/c/1');
        const l0 = container.querySelector('#l0');
        const l1Before = container.querySelector('#l1');
        const leafBefore = container.querySelector('#leaf');

        router.navigate('/a/1/b/2/c/1');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#l1')).not.toBe(l1Before);
        expect(container.querySelector('#leaf')).not.toBe(leafBefore);
        expect(counts).toMatchObject({ l0: 1, l1: 2, leaf: 2 });
        // The rebuilt subtree is still nested inside the retained ancestor.
        expect(l0!.querySelector('#l1 #leaf')).not.toBeNull();
        cleanup();
    });

    it('(c) a route-object change at level 1 retains level 0 and rebuilds 1-2', () =>
    {
        const OtherBranch = (): HTMLElement =>
        {
            counts.other += 1;
            return h('p', { id: 'z' }, 'z');
        };
        const routes: Route[] =
        [{
            path: '/a/:aid',
            component: L0,
            children:
            [
                {
                    path: 'b/:bid',
                    component: L1,
                    children: [{ path: 'c/:cid', component: Leaf }]
                },
                { path: 'z', component: OtherBranch }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/a/1/b/1/c/1');
        const l0 = container.querySelector('#l0');

        router.navigate('/a/1/z');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#l1')).toBeNull();
        expect(container.querySelector('#leaf')).toBeNull();
        expect(l0!.querySelector('#z')).not.toBeNull();
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 1, other: 1 });
        cleanup();
    });

    it('(d) an index-child <-> param-child swap keeps the layout, both directions', () =>
    {
        const Index = (): HTMLElement =>
        {
            counts.other += 1;
            return h('ul', { id: 'index' }, 'list');
        };
        const routes: Route[] =
        [{
            path: '/users',
            component: L0,
            children:
            [
                { path: '', component: Index },
                { path: ':id', component: Leaf }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users');
        const l0 = container.querySelector('#l0');
        expect(container.querySelector('#index')).not.toBeNull();

        router.navigate('/users/7');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#index')).toBeNull();
        expect(l0!.querySelector('#leaf')).not.toBeNull();

        router.navigate('/users');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#leaf')).toBeNull();
        expect(l0!.querySelector('#index')).not.toBeNull();
        expect(counts.l0).toBe(1);
        cleanup();
    });

    it('a query-only change retains every segment', () =>
    {
        const { router, container, cleanup } = mountApp(chainRoutes(), '/a/1/b/1/c/1');
        const l0 = container.querySelector('#l0');
        const l1 = container.querySelector('#l1');
        const leaf = container.querySelector('#leaf');

        router.navigate('/a/1/b/1/c/1?tab=activity');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#l1')).toBe(l1);
        expect(container.querySelector('#leaf')).toBe(leaf);
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 1 });
        cleanup();
    });

    it('a hash-only change retains every segment', () =>
    {
        const { router, container, cleanup } = mountApp(chainRoutes(), '/a/1/b/1/c/1');
        const leaf = container.querySelector('#leaf');

        router.navigate('/a/1/b/1/c/1#section');
        expect(container.querySelector('#leaf')).toBe(leaf);
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 1 });
        cleanup();
    });

    it('fallback <-> match swaps happen at segment 0 (whole chain, both directions)', () =>
    {
        const NotFound = (): HTMLElement => h('h1', { id: 'nf' }, '404');
        const { router, container, cleanup } = mountApp(chainRoutes(), '/a/1/b/1/c/1', NotFound);
        expect(container.querySelector('#l0')).not.toBeNull();

        router.navigate('/nowhere');
        expect(container.querySelector('#l0')).toBeNull();
        expect(container.querySelector('#nf')).not.toBeNull();

        router.navigate('/a/2/b/2/c/2');
        expect(container.querySelector('#nf')).toBeNull();
        expect(container.querySelector('#l0 #l1 #leaf')).not.toBeNull();
        expect(counts).toMatchObject({ l0: 2, l1: 2, leaf: 2 });
        cleanup();
    });

    it('(e) changing a trailing wildcard value rebuilds the declaring level, retains the layout', () =>
    {
        const DocLeaf = (): HTMLElement =>
        {
            counts.leaf += 1;
            return h('article', { id: 'doc' }, 'doc');
        };
        const routes: Route[] =
        [{
            path: '/docs',
            component: L0,
            children: [{ path: '*rest', component: DocLeaf }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/docs/a/b');
        const l0 = container.querySelector('#l0');
        const docBefore = container.querySelector('#doc');

        router.navigate('/docs/c');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#doc')).not.toBe(docBefore);
        expect(counts).toMatchObject({ l0: 1, leaf: 2 });
        cleanup();
    });

    it('(f) a lazy leaf landing under a warm layout leaves the layout untouched across the chainReady flip', async () =>
    {
        const Warm = (): HTMLElement => h('em', { id: 'warm' }, 'warm');
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const routes: Route[] =
        [{
            path: '/p',
            component: L0,
            children:
            [
                { path: 'warm', component: Warm },
                { path: 'cold', lazy: () => chunk }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p/warm');
        const l0 = container.querySelector('#l0');
        expect(container.querySelector('#warm')).not.toBeNull();

        router.navigate('/p/cold');
        await flush();
        // The hold: previous screen intact while the chunk is in flight.
        expect(container.querySelector('#warm')).not.toBeNull();
        expect(container.querySelector('#l0')).toBe(l0);

        release({ default: Leaf });
        await flush();
        // The chainReady flip fills the leaf; the layout's identity and body count are
        // untouched (a broken-proof target - a slot effect reading chainReady() directly
        // would tear the layout down on the chunk arrival).
        expect(container.querySelector('#l0')).toBe(l0);
        expect(counts.l0).toBe(1);
        expect(container.querySelector('#warm')).toBeNull();
        expect(l0!.querySelector('#leaf')).not.toBeNull();
        cleanup();
    });

    it('(g) a layout whose body reads useParams() directly is still retained on a leaf param change', () =>
    {
        const seen: string[] = [];
        const ReadingLayout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            counts.l0 += 1;
            const params = useParams();
            // A body-level read: without the untracked build (broken-proofed) the ancestor
            // slot would track `match` here and re-run on every navigation.
            seen.push(params().id ?? '');
            return h('div', { id: 'l0' }, Outlet({ children: props.children }));
        };
        const routes: Route[] =
        [{
            path: '/users',
            component: ReadingLayout,
            children: [{ path: ':id', component: Leaf }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        const l0 = container.querySelector('#l0');

        router.navigate('/users/2');
        expect(container.querySelector('#l0')).toBe(l0);
        expect(counts.l0).toBe(1);
        expect(seen).toEqual(['1']);
        cleanup();
    });
});

describe('the param-remount contract (3.3, exact wording)', () =>
{
    it('across /users/1 -> /users/2 the layout body does not re-execute and its node survives; the leaf remounts with fresh state, cleanup before mount', () =>
    {
        const log: string[] = [];
        let layoutBuilds = 0;
        let localEffectRuns = 0;
        let leafSetter: ((n: number) => void) | null = null;
        let leafValue: (() => number) | null = null;
        const paramValuesSeen: string[] = [];

        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            layoutBuilds += 1;
            const [local] = createSignal('layout-local');
            const params = useParams();
            // An effect reading ONLY layout-local signals: must NOT re-run on navigation.
            createEffect(() =>
            {
                local();
                localEffectRuns += 1;
            });
            // An effect reading a navigation-reactive source: MUST re-run with fresh values.
            createEffect(() =>
            {
                paramValuesSeen.push(String(params().id));
            });
            return h('div', { id: 'layout' }, Outlet({ children: props.children }));
        };

        const ParamLeaf = (): HTMLElement =>
        {
            const params = useParams();
            const id = String(params().id);
            log.push(`mount:${ id }`);
            onCleanup(() => log.push(`cleanup:${ id }`));
            const [n, setN] = createSignal(0);
            leafSetter = setN;
            leafValue = n;
            return h('span', { id: 'pleaf' }, id);
        };

        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            children: [{ path: ':id', component: ParamLeaf }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        const layoutBefore = container.querySelector('#layout');
        const leafBefore = container.querySelector('#pleaf');

        // Dirty the leaf's local state so a persist-instead-of-remount would show 5.
        leafSetter!(5);
        expect(leafValue!()).toBe(5);
        expect(log).toEqual(['mount:1']);

        router.navigate('/users/2');

        // Layout: retained. Body count unchanged, node identity preserved, local-only
        // effect quiet; the useParams-reading effect re-ran with the fresh value.
        expect(layoutBuilds).toBe(1);
        expect(container.querySelector('#layout')).toBe(layoutBefore);
        expect(localEffectRuns).toBe(1);
        expect(paramValuesSeen).toEqual(['1', '2']);

        // Leaf: REMOUNTED. Fresh node, fresh state, old cleanup before new mount.
        expect(container.querySelector('#pleaf')).not.toBe(leafBefore);
        expect(container.querySelector('#pleaf')!.textContent).toBe('2');
        expect(leafValue!()).toBe(0);
        expect(log).toEqual(['mount:1', 'cleanup:1', 'mount:2']);
        cleanup();
    });
});

describe('a vetoed navigation runs no slot effect', () =>
{
    it('builds nothing: not the vetoed route, and not a rebuild of the chain it replaced', async () =>
    {
        let guardRuns = 0;
        const routes: Route[] =
        [
            ...chainRoutes(),
            {
                path: '/secret',
                component: (): HTMLElement => h('div', { id: 'secret' }, 'secret'),
                guard: (): boolean =>
                {
                    guardRuns += 1;
                    return false;
                }
            }
        ];
        const { router, container, cleanup } = mountApp(routes, '/a/1/b/1/c/1');

        router.navigate('/secret');
        await flush();

        expect(guardRuns).toBeGreaterThan(0);
        // The vetoed component is never constructed - the half this test exists for.
        expect(container.querySelector('#secret')).toBeNull();
        // The navigation SETTLES at the target, so the chain it left is torn down rather than
        // retained; what must not happen is a REBUILD, and the counters say it did not.
        expect(router.state()).toEqual({ kind: 'blocked', status: 403 });
        expect(container.querySelector('#l0')).toBeNull();
        expect(counts).toMatchObject({ l0: 1, l1: 1, leaf: 1 });
        cleanup();
    });
});

describe('redirects land with the same retention rules as direct navigation', () =>
{
    it('a guard redirect into a sibling leaf retains the shared layout', async () =>
    {
        const routes: Route[] =
        [
            {
                path: '/users',
                component: L0,
                children: [{ path: ':id', component: Leaf }]
            },
            {
                path: '/me',
                component: (): HTMLElement => h('div', { id: 'me' }, 'me'),
                guard: (): string => '/users/2'
            }
        ];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        const l0 = container.querySelector('#l0');
        const leafBefore = container.querySelector('#leaf');

        router.navigate('/me');
        await flush();

        expect(router.location().pathname).toBe('/users/2');
        expect(container.querySelector('#me')).toBeNull();
        // Same rules as a direct /users/1 -> /users/2: layout retained, leaf remounted.
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#leaf')).not.toBe(leafBefore);
        expect(counts).toMatchObject({ l0: 1, leaf: 2 });
        cleanup();
    });

    it('a loader redirect into a sibling leaf retains the shared layout', async () =>
    {
        const routes: Route[] =
        [{
            path: '/users',
            component: L0,
            children:
            [
                {
                    path: 'gone',
                    component: (): HTMLElement => h('div', { id: 'gone' }, 'gone'),
                    loader: async (): Promise<never> =>
                    {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect() IS the documented throwable sentinel
                        throw redirect('/users/9');
                    }
                },
                { path: ':id', component: Leaf }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        const l0 = container.querySelector('#l0');
        const leafBefore = container.querySelector('#leaf');

        router.navigate('/users/gone');
        await flush();

        expect(router.location().pathname).toBe('/users/9');
        expect(container.querySelector('#gone')).toBeNull();
        expect(container.querySelector('#l0')).toBe(l0);
        expect(container.querySelector('#leaf')).not.toBe(leafBefore);
        expect(counts.l0).toBe(1);
        cleanup();
    });
});
