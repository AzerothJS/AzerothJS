// @vitest-environment happy-dom
//
// The hydration matrix for the per-segment route tree.
// (a) per-segment round trips preserve SERVER NODE identity per level, including a cold
//     LEAF chunk under a warm layout - in an elements-and-holes fixture that must adopt
//     cleanly as well as a nested control-flow fixture that must retain its served child;
// (b) divergence: a leftover trailing node inside a nested outlet range falls back
//     (broken-proofed), and the flipped-condition hole (server serialized [ ], client
//     resolves the slot handle) is a MISMATCH, not a silent repair;
// (c) navigating during adoption: (i) during the lazy wait; (ii) redirect-on-mount during
//     a DEFERRED adoption with a shared retained layout;
// (d) version skew against a legacy flat fixture: the skew-specific CONTEXT STRING
//     (broken-proofed);
// (f) redirect-on-mount during a SYNCHRONOUS adoption (broken-proofed);
// (g) a client-only <Routes> mounting while a sibling instance's ticket holds the pass
//     open builds FRESH (broken-proofed).
import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, h, hydrate, render, renderToString, Show, ErrorBoundary, For } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet, RouterProvider, Link, useParams, LOADER_HANDOFF_VERSION } from 'azerothjs';
import { componentScope } from 'azerothjs/internal';
import type { Route, RouteComponent, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Counter leaf: the liveness probe - inert markup cannot move the text. */
function CounterLeaf(): HTMLElement
{
    const [count, setCount] = createSignal(0);
    return h('section', { id: 'leaf' },
        h('span', { id: 'out' }, () => `count:${ count() }`),
        h('button', { id: 'go', onClick: () => setCount(count() + 1) }, 'inc'));
}

const NestedLayout = (props: { children?: MountNode | undefined }): MountNode =>
    h('div', { id: 'layout' }, h('header', {}, 'shell'), Outlet({ children: props.children }));

/** Server markup for a routed tree at `url`, appended to the document (delegated clicks). */
function ssrPage(routes: Route[], url: string): HTMLElement
{
    const router = createRouter({ routes, history: createMemoryHistory(url) });
    const container = document.createElement('div');
    container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router })));
    document.body.appendChild(container);
    return container;
}

function clientRouter(routes: Route[], url: string): Router
{
    return createRouter({ routes, history: createMemoryHistory(url) });
}

const mount = (router: Router, container: HTMLElement): void =>
    hydrate(() => h('div', { id: 'app' }, Routes({ router })), container);

describe('per-segment round trip', () =>
{
    it('adopts the initial gallery through an asynchronous guard and chunk without replacing a typed draft', async () =>
    {
        const url = '/gallery';
        const Gallery = (): HTMLElement => h('main', {}, h('input', { id: 'draft' }), h('p', {}, 'Gallery'));
        const shell = (router: Router): HTMLElement => h('div', {},
            h('button', { id: 'shell-control' }, 'Menu'),
            Routes({ router, fallback: () => h('p', { id: 'missing' }, 'Missing') }));
        const host = document.createElement('div');
        host.innerHTML = renderToString(() => shell(createRouter({
            routes: [{ path: url, component: Gallery }],
            history: createMemoryHistory(url)
        })));
        document.body.appendChild(host);
        const draft = host.querySelector<HTMLInputElement>('#draft')!;
        const menu = host.querySelector<HTMLButtonElement>('#shell-control')!;
        draft.value = 'my draft';
        menu.focus();
        let releaseGuard!: (admit: boolean) => void;
        const guard = new Promise<boolean>(resolve =>
        {
            releaseGuard = resolve;
        });
        let releaseChunk!: (chunk: RouteComponent) => void;
        const chunk = new Promise<RouteComponent>(resolve =>
        {
            releaseChunk = resolve;
        });
        const hydrateGallery = (): HTMLElement => shell(createRouter({
            routes: [{ path: url, guard: () => guard, lazy: () => chunk }],
            history: createMemoryHistory(url)
        }));
        try
        {
            hydrate(hydrateGallery, host);
            expect(host.querySelector('#draft')).toBe(draft);
            expect(host.querySelector('#missing')).toBeNull();
            releaseGuard(true);
            await flush();
            expect(host.querySelector('#draft')).toBe(draft);
            releaseChunk(Gallery);
            await flush();
            expect(host.querySelector('#draft')).toBe(draft);
            expect(draft.value).toBe('my draft');
            expect(host.querySelector('#shell-control')).toBe(menu);
            expect(document.activeElement).toBe(menu);
        }
        finally
        {
            render(() => h('div', {}), host);
            host.remove();
        }
    });

    it('a fragment changed during deferred adoption keeps the same gallery document and its draft', async () =>
    {
        const Gallery = (): HTMLElement => h('main', {}, h('input', { id: 'draft' }));
        const host = ssrPage([{ path: '/gallery', component: Gallery }], '/gallery');
        const draft = host.querySelector<HTMLInputElement>('#draft')!;
        draft.value = 'in progress';
        let resolve!: (page: RouteComponent) => void;
        const chunk = new Promise<RouteComponent>(r =>
        {
            resolve = r;
        });
        const router = clientRouter([{ path: '/gallery', lazy: () => chunk }], '/gallery');
        try
        {
            mount(router, host);
            router.navigate('/gallery#notes');
            resolve(Gallery);
            await flush();
            expect(router.location().fullPath).toBe('/gallery#notes');
            expect(host.querySelector('#draft')).toBe(draft);
            expect(draft.value).toBe('in progress');
        }
        finally
        {
            render(() => h('div', {}), host);
            host.remove();
        }
    });

    it('keeps the served blocked branch and its node while the client confirms its seeded status', async () =>
    {
        const url = '/gallery';
        const seed = { version: LOADER_HANDOFF_VERSION, path: url, data: [], denied: 403 as const };
        let resolve!: (allowed: boolean) => void;
        const verdict = new Promise<boolean>(r =>
        {
            resolve = r;
        });
        const view = (): HTMLElement =>
        {
            const router = createRouter({
                routes: [{ path: url, guard: () => verdict, component: () => h('p', {}, 'Gallery') }],
                history: createMemoryHistory(url),
                initialLoaderData: seed
            });
            return h('div', {}, Routes({
                router,
                blocked: ({ status }) => h('p', { id: 'notice' }, String(status)),
                fallback: () => h('p', { id: 'missing' }, 'Missing')
            }));
        };
        const host = document.createElement('div');
        host.innerHTML = renderToString(view);
        document.body.appendChild(host);
        const notice = host.querySelector('#notice');
        expect(notice?.textContent).toBe('403');
        try
        {
            hydrate(view, host);
            expect(host.querySelector('#notice')).toBe(notice);
            expect(host.querySelector('#missing')).toBeNull();
            resolve(false);
            await flush();
            expect(host.querySelector('#notice')).toBe(notice);
        }
        finally
        {
            render(() => h('div', {}), host);
            host.remove();
        }
    });

    it('a warm nested chain adopts with SERVER NODE identity preserved per level, and is live', async () =>
    {
        const routes: Route[] =
        [{
            path: '/users',
            component: NestedLayout,
            children: [{ path: ':id', component: CounterLeaf }]
        }];
        const container = ssrPage(routes, '/users/1');
        const serverLayout = container.querySelector('#layout');
        const serverLeaf = container.querySelector('#leaf');

        mount(clientRouter(routes, '/users/1'), container);
        await flush();

        expect(container.querySelector('#layout')).toBe(serverLayout);
        expect(container.querySelector('#leaf')).toBe(serverLeaf);
        container.querySelector<HTMLButtonElement>('#go')!.click();
        expect(container.querySelector('#out')!.textContent).toBe('count:1');
        container.remove();
    });

    it('a cold LEAF chunk under a warm layout adopts after the wait (elements-and-holes fixture)', async () =>
    {
        const serverRoutes: Route[] =
        [{
            path: '/users',
            component: NestedLayout,
            children: [{ path: ':id', component: CounterLeaf }]
        }];
        const container = ssrPage(serverRoutes, '/users/1');
        const serverLayout = container.querySelector('#layout');
        const serverLeaf = container.querySelector('#leaf');

        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const clientRoutes: Route[] =
        [{
            path: '/users',
            component: NestedLayout,
            children: [{ path: ':id', lazy: () => chunk }]
        }];
        mount(clientRouter(clientRoutes, '/users/1'), container);

        release({ default: CounterLeaf });
        await flush();

        expect(container.querySelector('#layout')).toBe(serverLayout);
        expect(container.querySelector('#leaf')).toBe(serverLeaf);
        container.querySelector<HTMLButtonElement>('#go')!.click();
        expect(container.querySelector('#out')!.textContent).toBe('count:1');
        container.remove();
    });

    it.each([false, true])('adopts its Show and keeps controls inside an ErrorBoundary live (cold=%s)', async cold =>
    {
        const [visible, setVisible] = createSignal(true);
        const CfLeaf = (): HTMLElement =>
            h('section', { id: 'leaf' },
                Show({ when: visible, children: () => h('p', { id: 'retained' }, 'visible') }),
                ErrorBoundary({
                    fallback: (error) => h('div', { id: 'adoption-error' }, String(error instanceof Error ? error.message : error)),
                    children: () => Show({ when: visible, children: () => h('p', { id: 'cf' }, 'cf') })
                }));
        const serverRoutes: Route[] =
        [{
            path: '/p',
            component: NestedLayout,
            children: [{ path: 'x', component: CfLeaf }]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(serverRoutes, '/p/x');
            const serverLayout = container.querySelector('#layout');
            const serverShow = container.querySelector('#retained');
            expect(serverShow).not.toBeNull();

            let release!: (chunk: { default: RouteComponent }) => void;
            const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
            {
                release = resolve;
            });
            const clientRoutes: Route[] =
            [{
                path: '/p',
                component: NestedLayout,
                children: [{ path: 'x', lazy: () => chunk }]
            }];
            mount(clientRouter(cold ? clientRoutes : serverRoutes, '/p/x'), container);
            release({ default: CfLeaf });
            await flush();
            await flush();

            expect(container.querySelector('#layout')).toBe(serverLayout);
            expect(container.querySelector('#retained')).toBe(serverShow);
            expect(container.querySelectorAll('#cf')).toHaveLength(1);
            setVisible(false);
            expect(container.querySelector('#retained')).toBeNull();
            expect(container.querySelector('#cf')).toBeNull();
            setVisible(true);
            expect(container.querySelectorAll('#retained')).toHaveLength(1);
            expect(container.querySelectorAll('#cf')).toHaveLength(1);
            expect(container.querySelector('#adoption-error')).toBeNull();
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);
            expect(messages.some((m) => /createEffect\(\) called with no owner/.test(m))).toBe(false);
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('divergence', () =>
{
    it('a leftover trailing node inside a nested outlet range falls back to a clean client render', async () =>
    {
        const routes: Route[] =
        [{
            path: '/users',
            component: NestedLayout,
            children: [{ path: ':id', component: CounterLeaf }]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(routes, '/users/1');
            // Sabotage the SERVER MARKUP: an extra element inside the outlet range, after
            // the leaf. The client build consumes the leaf and must then find the range
            // NOT exhausted (broken-proof control: skip the slot's assertExhausted and this
            // leftover is silently kept).
            const leaf = container.querySelector('#leaf')!;
            const stray = document.createElement('i');
            stray.id = 'stray';
            stray.textContent = 'stray';
            leaf.parentNode!.insertBefore(stray, leaf.nextSibling);

            mount(clientRouter(routes, '/users/1'), container);
            await flush();

            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(true);
            // Recovered: the stray is gone and the rebuilt page is live.
            expect(container.querySelector('#stray')).toBeNull();
            container.querySelector<HTMLButtonElement>('#go')!.click();
            expect(container.querySelector('#out')!.textContent).toBe('count:1');
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('the flipped-condition hole (server serialized [ ], client resolves the handle) is a MISMATCH, not a silent repair', async () =>
    {
        // The layout renders `{ cond ? <span/> : props.children }`. The server had cond
        // TRUE (an ordinary [ ] reactive hole holding the span); the client resolves cond
        // FALSE - the hole's first resolution yields the SLOT HANDLE inside a [ ] range.
        // 3.1's symmetric rule: that is a mismatch -> whole-container fallback.
        const makeLayout = (cond: boolean) => (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                h('div', { id: 'hole-host' }, () => (cond ? h('span', { id: 'server-branch' }, 's') : props.children)));
        const serverRoutes: Route[] =
        [{
            path: '/p',
            component: makeLayout(true),
            children: [{ path: 'x', component: CounterLeaf }]
        }];
        const clientRoutes: Route[] =
        [{
            path: '/p',
            component: makeLayout(false),
            children: [{ path: 'x', component: CounterLeaf }]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(serverRoutes, '/p/x');
            mount(clientRouter(clientRoutes, '/p/x'), container);
            await flush();

            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(true);
            // The client-rendered page shows the CLIENT truth: the slot content.
            expect(container.querySelector('#server-branch')).toBeNull();
            expect(container.querySelector('#leaf')).not.toBeNull();
            container.querySelector<HTMLButtonElement>('#go')!.click();
            expect(container.querySelector('#out')!.textContent).toBe('count:1');
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('navigating during adoption', () =>
{
    it('mounts the destination inside the Routes range and preserves the shell during a lazy wait', async () =>
    {
        let clicks = 0;
        const button = (click: () => void): HTMLElement => h('button', { class: 'action', onClick: click }, 'Select');
        const start = (): HTMLElement => button(() => undefined);
        const destination = (): HTMLElement => button(() =>
        {
            clicks++;
        });
        const view = (router: Router): HTMLElement => h('main', {}, h('input', { id: 'shell-draft' }), Routes({ router }));
        const host = document.createElement('div');
        host.innerHTML = renderToString(() => view(createRouter({
            routes: [{ path: '/start', component: start }], history: createMemoryHistory('/start')
        })));
        document.body.appendChild(host);
        const shell = host.querySelector<HTMLInputElement>('#shell-draft')!;
        const initialButton = host.querySelector('button.action');
        expect(initialButton).not.toBeNull();
        shell.value = 'draft';
        const chunk = Promise.withResolvers<RouteComponent>();
        const router = clientRouter([
            { path: '/start', lazy: () => chunk.promise },
            { path: '/next', component: destination }
        ], '/start');
        try
        {
            hydrate(() => view(router), host);
            router.navigate('/next');
            await flush();
            const current = host.querySelector<HTMLButtonElement>('button.action')!;
            expect(current).not.toBeNull();
            expect(current).not.toBe(initialButton);
            expect(host.querySelector('#shell-draft')).toBe(shell);
            expect(shell.value).toBe('draft');
            current.click();
            expect(clicks).toBe(1);
            chunk.resolve(start);
            await flush();
            expect(host.querySelector('button.action')).toBe(current);
        }
        finally
        {
            render(() => h('div', {}), host);
            host.remove();
        }
    });

    it('(i) a navigation during the LAZY WAIT lands the newer match cleanly', async () =>
    {
        const serverRoutes: Route[] =
        [
            {
                path: '/p',
                component: NestedLayout,
                children: [{ path: 'x', component: CounterLeaf }]
            },
            { path: '/other', component: (): HTMLElement => h('main', { id: 'other' }, 'other') }
        ];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(serverRoutes, '/p/x');

            let release!: (chunk: { default: RouteComponent }) => void;
            const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
            {
                release = resolve;
            });
            const clientRoutes: Route[] =
            [
                {
                    path: '/p',
                    component: NestedLayout,
                    children: [{ path: 'x', lazy: () => chunk }]
                },
                { path: '/other', component: (): HTMLElement => h('main', { id: 'other' }, 'other') }
            ];
            const router = clientRouter(clientRoutes, '/p/x');
            mount(router, container);

            // Mid-wait: the ticket is open, nothing adopted yet.
            router.navigate('/other');
            await flush();
            release({ default: CounterLeaf });
            await flush();

            // This navigation has its own route range and must remain current when the old chunk lands.
            expect(container.querySelector('#other')).not.toBeNull();
            expect(container.querySelector('#leaf')).toBeNull();
            expect(container.querySelector('#layout')).toBeNull();
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('(ii) redirect-on-mount during a DEFERRED adoption: the shared retained layout keeps its SERVER nodes, zero mismatches', async () =>
    {
        const ServerX = (): HTMLElement => h('span', { id: 'x' }, 'x');
        const Y = (): HTMLElement => h('span', { id: 'y' }, 'y');
        const serverRoutes: Route[] =
        [{
            path: '/p',
            component: NestedLayout,
            children:
            [
                { path: 'x', component: ServerX },
                { path: 'y', component: Y }
            ]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(serverRoutes, '/p/x');
            const serverLayout = container.querySelector('#layout');

            let release!: (chunk: { default: RouteComponent }) => void;
            const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
            {
                release = resolve;
            });
            // The client X navigates away on mount - same markup as ServerX, plus the
            // effect (fires after the adoption completes; hoisted so the route table
            // can name it before the router exists).
            function ClientX(): HTMLElement
            {
                createEffect(() =>
                {
                    router.navigate('/p/y');
                });
                return h('span', { id: 'x' }, 'x');
            }
            const clientRoutes: Route[] =
            [{
                path: '/p',
                component: NestedLayout,
                children:
                [
                    { path: 'x', lazy: () => chunk },
                    { path: 'y', component: Y }
                ]
            }];
            const router = clientRouter(clientRoutes, '/p/x');
            mount(router, container);
            release({ default: ClientX });
            await flush();
            await flush();

            expect(container.querySelector('#layout')).toBe(serverLayout);
            expect(container.querySelector('#y')).not.toBeNull();
            expect(container.querySelector('#x')).toBeNull();
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('version skew (legacy flat fixture)', () =>
{
    it('the fallback DEV warning carries the skew-specific context string', async () =>
    {
        // A CAPTURED legacy page: the old flat serializer emitted the child INLINE - no
        // azc:outlet range - and the leaf's root is a control-flow component, so the
        // node where the current client expects `azc:outlet` is an `azc:show` anchor.
        const container = document.createElement('div');
        container.innerHTML = '<div id="app"><!--azc:routes--><div id="layout"><header>shell</header>'
            + '<!--azc:show--><p id="cf">cf</p><!--/azc--></div><!--/azc--></div>';
        document.body.appendChild(container);

        const CfLeaf = (): HTMLElement =>
            h('section', { id: 'leaf' },
                Show({ when: () => true, children: () => h('p', { id: 'cf' }, 'cf') }));
        const routes: Route[] =
        [{
            path: '/p',
            component: NestedLayout,
            children: [{ path: 'x', component: CfLeaf }]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            mount(clientRouter(routes, '/p/x'), container);
            await flush();

            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            // The assertion IS the context string (broken-proof control: without the label
            // check the fallback still happens, from a deeper site WITHOUT this text).
            expect(messages.some((m) => /version skew/.test(m))).toBe(true);
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(true);
            // Degraded, not broken: the client render converged.
            expect(container.querySelector('#leaf')).not.toBeNull();
            expect(container.querySelector('#cf')).not.toBeNull();
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('redirect-on-mount during a SYNCHRONOUS adoption', () =>
{
    it('converges to the second target; the shared retained layout keeps its server nodes; zero mismatches', async () =>
    {
        const ServerX = (): HTMLElement => h('span', { id: 'x' }, 'x');
        const Y = (): HTMLElement => h('span', { id: 'y' }, 'y');
        const serverRoutes: Route[] =
        [{
            path: '/p',
            component: NestedLayout,
            children:
            [
                { path: 'x', component: ServerX },
                { path: 'y', component: Y }
            ]
        }];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(serverRoutes, '/p/x');
            const serverLayout = container.querySelector('#layout');

            function ClientX(): HTMLElement
            {
                createEffect(() =>
                {
                    router.navigate('/p/y');
                });
                return h('span', { id: 'x' }, 'x');
            }
            const clientRoutes: Route[] =
            [{
                path: '/p',
                component: NestedLayout,
                children:
                [
                    { path: 'x', component: ClientX },
                    { path: 'y', component: Y }
                ]
            }];
            const router = clientRouter(clientRoutes, '/p/x');
            // WARM chain: the whole adoption happens in hydrate()'s synchronous window;
            // the mid-walk committed change must not re-run adopted slots against the
            // still-open pass (broken-proof control: ignore `adopting` and the layout's server
            // node identity is lost / a mismatch fires).
            mount(router, container);
            await flush();

            expect(container.querySelector('#layout')).toBe(serverLayout);
            expect(container.querySelector('#y')).not.toBeNull();
            expect(container.querySelector('#x')).toBeNull();
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('a client-only <Routes> beside a held ticket', () =>
{
    it('builds FRESH while the sibling instance waits, and both end correct', async () =>
    {
        const [showB, setShowB] = createSignal(false);
        const shellRoutes: Route[] = [{ path: '/', component: CounterLeaf }];

        // Server: B's zone is off; A is warm.
        const serverRouterA = createRouter({ routes: shellRoutes, history: createMemoryHistory('/') });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' },
            Show({ when: showB, children: () => h('div', { id: 'b-zone' }, 'never-on-server') }),
            Routes({ router: serverRouterA })));
        document.body.appendChild(container);
        const serverLeaf = container.querySelector('#leaf');

        // Client: A is lazy-cold - its ticket holds the pass open.
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const routerA = createRouter({ routes: [{ path: '/', lazy: () => chunk }], history: createMemoryHistory('/') });
        const routerB = createRouter({
            routes: [{ path: '/', component: (): HTMLElement => h('nav', { id: 'b-nav' }, 'b') }],
            history: createMemoryHistory('/')
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            hydrate(() => h('div', { id: 'app' },
                Show({ when: showB, children: () => h('div', { id: 'b-zone' }, Routes({ router: routerB })) }),
                Routes({ router: routerA })), container);

            // The pass is held open by A's ticket. Mount the CLIENT-ONLY instance now:
            // it must build fresh (per-slot firstRun, NOT isHydrating() - broken-proofed).
            setShowB(true);
            await flush();
            expect(container.querySelector('#b-nav')).not.toBeNull();

            release({ default: CounterLeaf });
            await flush();

            // A adopted its server nodes; B is intact; no fallback anywhere.
            expect(container.querySelector('#leaf')).toBe(serverLeaf);
            container.querySelector<HTMLButtonElement>('#go')!.click();
            expect(container.querySelector('#out')!.textContent).toBe('count:1');
            expect(container.querySelector('#b-nav')).not.toBeNull();
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);
            container.remove();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('context reaches content built during the hydration walk (the users-page defect)', () =>
{
    it('a <Link> inside a <For> row of a provider-resolved chain hydrates live, with no router error', async () =>
    {
        // Found by real-app browser evidence: the hydration walk runs AFTER the component
        // stack that created the descriptors returned, so row builds executed under the
        // CONTAINER owner - outside <RouterProvider>'s scope and outside the synchronous
        // route frame - and every Link in a row threw "found no router", leaving the
        // whole page inert with NO fallback. hydrationNode must adopt under its
        // CREATION owner, the same scope dom mode's synchronous construction uses.
        const names = ['aria', 'borin', 'cael'];
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' },
                h('ul', { id: 'list' },
                    For({
                        each: () => names,
                        key: (name) => name,
                        children: (name) => h('li', {},
                            Link({ to: `/users/${ name() }`, children: name() }))
                    })),
                Outlet({ children: props.children }));
        const Leaf = (): HTMLElement =>
        {
            const params = useParams();
            return h('span', { id: 'leaf' }, () => String(params().id));
        };
        const routes: Route[] =
        [{
            path: '/users',
            component: Layout,
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'idx' }, 'pick') },
                { path: ':id', component: Leaf }
            ]
        }];

        // componentScope mirrors the COMPILED invocation: the provider's context lands on
        // its own component scope (exited by walk time), not the ambient container root -
        // without it this repro passes vacuously because h-land provideContext writes to
        // the container root, which the walk still sees.
        const makeApp = (router: Router) => (): HTMLElement =>
            h('div', { id: 'app' },
                componentScope(() => RouterProvider({ router, children: () => Routes({}) })));

        const serverRouter = createRouter({ routes, history: createMemoryHistory('/users') });
        const container = document.createElement('div');
        container.innerHTML = renderToString(makeApp(serverRouter));
        document.body.appendChild(container);
        const serverLayout = container.querySelector('#layout');

        const errors: string[] = [];
        const onError = (event: ErrorEvent): void =>
        {
            errors.push(String(event.error ?? event.message));
            event.preventDefault();
        };
        window.addEventListener('error', onError);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const clientRouter = createRouter({ routes, history: createMemoryHistory('/users') });
            hydrate(makeApp(clientRouter), container);
            await flush();

            expect(errors.filter((e) => /found no router/.test(e))).toEqual([]);
            // Adopted, not fallen back - and LIVE: a row link click navigates the chain.
            expect(container.querySelector('#layout')).toBe(serverLayout);
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(false);

            const link = container.querySelector<HTMLAnchorElement>('#list a')!;
            const ev = new MouseEvent('click', { button: 0, cancelable: true, bubbles: true });
            const guard = (e: Event): void => e.preventDefault();
            document.addEventListener('click', guard);
            link.dispatchEvent(ev);
            document.removeEventListener('click', guard);
            await flush();

            expect(clientRouter.location().pathname).toBe('/users/aria');
            expect(container.querySelector('#leaf')!.textContent).toBe('aria');
            expect(container.querySelector('#layout')).toBe(serverLayout);
        }
        finally
        {
            warn.mockRestore();
            window.removeEventListener('error', onError);
        }
        container.remove();
    });
});

describe('the first navigation away from an ADOPTED segment animates', () =>
{
    it('the hydrated leaf plays its leave classes like a client-built branch would', async () =>
    {
        // Found by real-app browser evidence: adoption never ran buildInto - the only
        // recorder of the slot's currentEl - so a hydrated screen's FIRST swap was
        // instant while every later one animated. The adopted range's single-node
        // element root must be recorded at adoption.
        const routes: Route[] =
        [{
            path: '/p',
            component: NestedLayout,
            children:
            [
                { path: 'x', component: (): HTMLElement => h('main', { id: 'x', class: 'pg' }, 'x') },
                { path: 'y', component: (): HTMLElement => h('main', { id: 'y', class: 'pg' }, 'y') }
            ]
        }];
        const serverRouter = createRouter({ routes, history: createMemoryHistory('/p/x') });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' },
            Routes({ router: serverRouter, transition: 'route', transitionDuration: 40 })));
        document.body.appendChild(container);
        const serverX = container.querySelector('#x');

        const router = clientRouter(routes, '/p/x');
        hydrate(() => h('div', { id: 'app' },
            Routes({ router, transition: 'route', transitionDuration: 40 })), container);
        await flush();
        expect(container.querySelector('#x')).toBe(serverX);

        router.navigate('/p/y');
        // The ADOPTED x is demoted to leaving, in the DOM with the leave family on it.
        const leavingX = container.querySelector('#x');
        expect(leavingX).not.toBeNull();
        expect(leavingX!.className).toContain('route-leave-active');
        expect(container.querySelector('#y')).not.toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(container.querySelector('#x')).toBeNull();
        expect(container.querySelector('#y')).not.toBeNull();
        container.remove();
    });
});
