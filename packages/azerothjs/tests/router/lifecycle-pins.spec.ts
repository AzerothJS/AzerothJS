// @vitest-environment happy-dom
//
// The behavior-change pins. Each of these is an intentional,
// release-noted consequence of the per-segment route tree - pinned so a regression (or a
// silent revert) is caught by name.
import { describe, it, expect } from 'vitest';
import { createSignal, onCleanup, h, render } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet, Show, Portal, useLoader } from 'azerothjs';
import type { Route, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = (ms = 90): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface App { router: Router; container: HTMLElement; cleanup: () => void }

function mountApp(routes: Route[], initialUrl: string, transition?: string): App
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        return h('div', { id: 'app' }, Routes({ router, transition, transitionDuration: 40 }));
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

describe('a routed leaf\'s placed Outlet yields an empty marker range', () =>
{
    it('no placeholder span; the outlet comment pair brackets nothing', () =>
    {
        const LeafWithOutlet = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'leaf' }, Outlet({ children: props.children }));
        const routes: Route[] = [{ path: '/', component: LeafWithOutlet }];
        const { container, cleanup } = mountApp(routes, '/');

        const leaf = container.querySelector('#leaf')!;
        expect(leaf.querySelector('span')).toBeNull();
        const commentData = Array.from(leaf.childNodes)
            .filter((n) => n.nodeType === 8)
            .map((n) => (n as Comment).data);
        expect(commentData).toContain('outlet');
        expect(commentData).toContain('/outlet');
        cleanup();
    });
});

describe('a retained layout\'s loader HOLDS across a leaf navigation', () =>
{
    it('no refetch, no loading flip; revalidate() re-runs it with current params', async () =>
    {
        let runs = 0;
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            const data = useLoader<string>();
            return h('div', { id: 'layout' },
                h('em', { id: 'status' }, () => (data.loading() ? 'loading' : String(data.data()))),
                Outlet({ children: props.children }));
        };
        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            loader: async ({ params }) =>
            {
                runs += 1;
                return `v:${ params.id ?? 'none' }`;
            },
            children: [{ path: ':id', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/users/1');
        await flush();
        const layout = container.querySelector('#layout');
        expect(container.querySelector('#status')!.textContent).toBe('v:1');
        expect(runs).toBe(1);

        router.navigate('/users/2');
        await flush();
        // The layout's own inputs did not change: its loader does NOT re-run on a
        // leaf param change, its data holds, and loading never flips. (A parent
        // loader reading a DESCENDANT's param is outside its declared inputs -
        // revalidate() is the sanctioned way to re-run it.)
        expect(runs).toBe(1);
        expect(container.querySelector('#layout')).toBe(layout);
        expect(container.querySelector('#status')!.textContent).toBe('v:1');

        await router.revalidate();
        await flush();
        // The re-run receives the CURRENT staged arguments.
        expect(runs).toBe(2);
        expect(container.querySelector('#status')!.textContent).toBe('v:2');
        cleanup();
    });
});

describe('portals across the segment lifecycle', () =>
{
    it('a portal in a RETAINED layout survives leaf navigations with the same DOM', async () =>
    {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                Portal({ target: host, children: () => h('div', { id: 'ptl' }, 'portal') }),
                Outlet({ children: props.children }));
        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            children: [{ path: ':id', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];
        const { router, cleanup } = mountApp(routes, '/users/1');
        const portalEl = host.querySelector('#ptl');
        expect(portalEl).not.toBeNull();

        router.navigate('/users/2');
        await flush();
        expect(host.querySelector('#ptl')).toBe(portalEl);
        cleanup();
        host.remove();
    });

    it('a portal in a LEAVING animated segment stays mounted until the leave settles, then disposes', async () =>
    {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const WithPortal = (): HTMLElement =>
            h('main', { class: 'pg a' },
                Portal({ target: host, children: () => h('div', { id: 'ptl' }, 'portal') }));
        const routes: Route[] =
        [
            { path: '/a', component: WithPortal },
            { path: '/b', component: (): HTMLElement => h('main', { class: 'pg b' }, 'b') }
        ];
        const { router, container, cleanup } = mountApp(routes, '/a', 'route');
        expect(host.querySelector('#ptl')).not.toBeNull();

        router.navigate('/b');
        // Mid-leave: the segment's root is not disposed yet, so the portal holds.
        expect(container.querySelector('.a')).not.toBeNull();
        expect(host.querySelector('#ptl')).not.toBeNull();

        await settle(90);
        await flush();
        expect(container.querySelector('.a')).toBeNull();
        expect(host.querySelector('#ptl')).toBeNull();
        cleanup();
        host.remove();
    });

    it('a rebuilt segment\'s cleanup observes isConnected === true (active path)', () =>
    {
        let connectedAtCleanup: boolean | null = null;
        const A = (): HTMLElement =>
        {
            const el = h('main', { id: 'a' }, 'a');
            onCleanup(() =>
            {
                connectedAtCleanup = el.isConnected;
            });
            return el;
        };
        const routes: Route[] =
        [
            { path: '/a', component: A },
            { path: '/b', component: (): HTMLElement => h('main', { id: 'b' }, 'b') }
        ];
        const { router, cleanup } = mountApp(routes, '/a');

        router.navigate('/b');
        // branchDispose runs BEFORE the element detaches (4 DISPOSE invariant b).
        expect(connectedAtCleanup).toBe(true);
        cleanup();
    });
});

describe('a layout that never places its children constructs nothing deeper', () =>
{
    it('the leaf component is not invoked at all', () =>
    {
        let leafBuilds = 0;
        const IgnoringLayout = (): MountNode => h('div', { id: 'layout' }, 'no outlet here');
        const routes: Route[] =
        [{
            path: '/p',
            component: IgnoringLayout,
            children:
            [{
                path: 'x',
                component: (): HTMLElement =>
                {
                    leafBuilds += 1;
                    return h('span', { id: 'leaf' }, 'leaf');
                }
            }]
        }];
        const { container, cleanup } = mountApp(routes, '/p/x');

        expect(container.querySelector('#layout')).not.toBeNull();
        expect(container.querySelector('#leaf')).toBeNull();
        expect(leafBuilds).toBe(0);
        cleanup();
    });
});

describe('a second placement while the first is LIVE throws in DEV', () =>
{
    it('placing the same children handle twice is refused by name', () =>
    {
        const DoublePlacing = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                Outlet({ children: props.children }),
                Outlet({ children: props.children }));
        const routes: Route[] =
        [{
            path: '/p',
            component: DoublePlacing,
            children: [{ path: '', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
        }];
        const container = document.createElement('div');
        document.body.appendChild(container);
        expect(() =>
        {
            render(() =>
            {
                const router = createRouter({ routes, history: createMemoryHistory('/p') });
                return h('div', {}, Routes({ router }));
            }, container);
        }).toThrow(/already placed/);
        container.remove();
    });
});

describe('a rebuilt single-element branch runs its element destroy hooks', () =>
{
    it('a delegated handler on the old leaf is cleared on navigation away', () =>
    {
        let clicks = 0;
        const A = (): HTMLElement => h('button', { id: 'btn', onClick: () =>
        {
            clicks += 1;
        } }, 'a');
        const routes: Route[] =
        [
            { path: '/a', component: A },
            { path: '/b', component: (): HTMLElement => h('main', { id: 'b' }, 'b') }
        ];
        const { router, container, cleanup } = mountApp(routes, '/a');

        const btn = container.querySelector<HTMLButtonElement>('#btn')!;
        // CONTROL: the harness can deliver a click at all.
        btn.click();
        expect(clicks).toBe(1);

        router.navigate('/b');
        // The single-element fast path must run destroyComponent: the delegated
        // handler map is a destroy hook, so a stale element that leaks back into the
        // page must be inert (release-noted behavior change; today's fast path
        // skipped destroyComponent).
        document.body.appendChild(btn);
        btn.click();
        expect(clicks).toBe(1);
        btn.remove();
        cleanup();
    });
});

describe('a Show-wrapped outlet toggling away and back', () =>
{
    it('disposes the placement, re-arms the handle, and REMOUNTS the leaf per reveal while the layout is retained', async () =>
    {
        let leafBuilds = 0;
        const cleaned: string[] = [];
        const [show, setShow] = createSignal(true);

        const TogglingLayout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                // The materializeChild PASS-THROUGH pin (broken-proofed): Show's branch build routes
                // the handle through materializeChild, which must return it untouched.
                Show({ when: show, children: () => props.children as never }));

        const routes: Route[] =
        [{
            path: '/p',
            component: TogglingLayout,
            children:
            [{
                path: '',
                component: (): HTMLElement =>
                {
                    leafBuilds += 1;
                    onCleanup(() => cleaned.push('leaf'));
                    return h('span', { id: 'leaf' }, 'leaf');
                }
            }]
        }];
        const { container, cleanup } = mountApp(routes, '/p');
        const layout = container.querySelector('#layout');
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(leafBuilds).toBe(1);

        setShow(false);
        await flush();
        expect(container.querySelector('#leaf')).toBeNull();
        expect(cleaned).toEqual(['leaf']);

        setShow(true);
        await flush();
        // Re-armed and re-placed: the leaf REMOUNTS per reveal.
        expect(container.querySelector('#leaf')).not.toBeNull();
        expect(leafBuilds).toBe(2);
        expect(container.querySelector('#layout')).toBe(layout);
        cleanup();
    });
});
