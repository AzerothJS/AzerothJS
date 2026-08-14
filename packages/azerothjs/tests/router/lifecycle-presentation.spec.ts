// @vitest-environment happy-dom
//
// Presentation (focus at the OUTERMOST REBUILT segment on a nested chain, transition at
// the changed slot only, synchronous commit), mid-flush navigation, the cold lazy client
// start (the PENDING pin), enter-cancel, and the races: per-slot flush, cascaded leaving
// disposal, an unaffected ancestor's leave continuing, supersession of the lazy hold.
import { describe, it, expect } from 'vitest';
import { createEffect, onCleanup, h, render } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import type { Route, RouteComponent, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = (ms = 90): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface App { router: Router; container: HTMLElement; cleanup: () => void }

type TransitionProp = Parameters<typeof Routes>[0]['transition'];

function mountApp(routes: Route[], initialUrl: string, transition?: TransitionProp): App
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

const layoutOf = (id: string) => (props: { children?: MountNode | undefined }): MountNode =>
    h('div', { id }, Outlet({ children: props.children }));

describe('presentation on a nested chain', () =>
{
    it('focus lands in the OUTERMOST REBUILT segment: the leaf on a leaf-only change, the middle layout on a middle change', async () =>
    {
        const routes: Route[] =
        [{
            path: '/a/:aid',
            component: layoutOf('l0'),
            children:
            [{
                path: 'b/:bid',
                component: layoutOf('l1'),
                children: [{ path: 'c/:cid', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
            }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/a/1/b/1/c/1');

        router.navigate('/a/1/b/1/c/2');
        await flush();
        // Leaf-only rebuild: the leaf root is the focus target, NOT the chain root.
        expect((document.activeElement as HTMLElement | null)?.id).toBe('leaf');

        router.navigate('/a/1/b/2/c/2');
        await flush();
        // Middle rebuild: level 1 is the outermost rebuilt segment.
        expect((document.activeElement as HTMLElement | null)?.id).toBe('l1');
        expect(container.querySelector('#l0')).not.toBeNull();
        cleanup();
    });

    it('the transition plays at the changed slot only: leaf classes yes, retained layout untouched', () =>
    {
        const routes: Route[] =
        [{
            path: '/p',
            component: layoutOf('l0'),
            children:
            [
                { path: 'x', component: (): HTMLElement => h('span', { class: 'pg x' }, 'x') },
                { path: 'y', component: (): HTMLElement => h('span', { class: 'pg y' }, 'y') }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p/x', 'route');

        router.navigate('/p/y');
        const layout = container.querySelector('#l0')!;
        const leaving = container.querySelector('.x')!;
        const entering = container.querySelector('.y')!;
        expect(leaving.className).toContain('route-leave-active');
        expect(entering.className).toContain('route-enter');
        // The retained layout carries NO transition classes - the animation is scoped
        // to the changed slot's depth.
        expect(layout.className).not.toContain('route-');
        // Both parties of the swap live INSIDE the retained layout.
        expect(layout.contains(leaving)).toBe(true);
        expect(layout.contains(entering)).toBe(true);
        cleanup();
    });

    it('SYNCHRONOUS COMMIT: the full rebuilt suffix is in the DOM when a guardless navigate() returns', () =>
    {
        const routes: Route[] =
        [{
            path: '/a/:aid',
            component: layoutOf('l0'),
            children:
            [{
                path: 'b/:bid',
                component: layoutOf('l1'),
                children: [{ path: 'c/:cid', component: (): HTMLElement => h('span', { id: 'leaf' }, 'leaf') }]
            }]
        }];
        const { router, container, cleanup } = mountApp(routes, '/a/1/b/1/c/1');

        router.navigate('/a/1/b/2/c/9');
        // No flush: levels 1 AND 2 are already committed - the whole rebuilt suffix,
        // not just the outermost rebuilt level (a broken-proof target).
        expect(container.querySelector('#l0 #l1 #leaf')).not.toBeNull();
        expect(container.querySelectorAll('#l1').length).toBe(1);
        cleanup();
    });
});

describe('mid-flush navigation', () =>
{
    it('an effect in a rebuilt segment navigating on mount leaves exactly the second target', async () =>
    {
        const routes: Route[] =
        [
            { path: '/a', component: (): HTMLElement => h('div', { id: 'a' }, 'a') },
            {
                path: '/b',
                component: (): HTMLElement =>
                {
                    createEffect(() =>
                    {
                        router.navigate('/c');
                    });
                    return h('div', { id: 'b' }, 'b');
                }
            },
            { path: '/c', component: (): HTMLElement => h('div', { id: 'c' }, 'c') }
        ];
        const { router, container, cleanup } = mountApp(routes, '/a');

        router.navigate('/b');
        await flush();

        expect(container.querySelector('#a')).toBeNull();
        expect(container.querySelector('#b')).toBeNull();
        expect(container.querySelector('#c')).not.toBeNull();
        expect(container.querySelectorAll('div[id]').length).toBe(2); // #app wrapper + #c
        cleanup();
    });
});

describe('cold lazy client start (the PENDING pin)', () =>
{
    it('renders NOTHING (never the fallback) until the chunk lands, and the fill moves no focus', async () =>
    {
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes: [{ path: '/', lazy: () => chunk }], history: createMemoryHistory('/') });
            return h('div', { id: 'app' }, Routes({ router, fallback: () => h('h1', { id: 'nf' }, '404') }));
        }, container);

        // The cold-start hold: no content AND no fallback flash.
        expect(container.querySelector('#nf')).toBeNull();
        expect(container.querySelector('#page')).toBeNull();

        const before = document.activeElement;
        release({ default: (): HTMLElement => h('main', { id: 'page' }, 'page') });
        await flush();

        expect(container.querySelector('#page')).not.toBeNull();
        expect(container.querySelector('#nf')).toBeNull();
        // The PENDING -> first-commit fill is not a navigation: no focus move.
        expect(document.activeElement).toBe(before);
        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('enter-cancel', () =>
{
    it('a navigation mid-ENTER demotes the entering element with no enter classes left, and its leave settles exactly once', async () =>
    {
        const log: string[] = [];
        const page = (name: string) => (): HTMLElement =>
        {
            onCleanup(() => log.push(`cleanup:${ name }`));
            return h('main', { class: `pg ${ name }` }, name);
        };
        const routes: Route[] =
        [
            { path: '/x', component: page('x') },
            { path: '/y', component: page('y') }
        ];
        const { router, container, cleanup } = mountApp(routes, '/x', 'route');

        router.navigate('/y'); // y starts ENTERING
        const entering = container.querySelector('.y')!;
        expect(entering.className).toContain('route-enter');

        router.navigate('/x'); // mid-enter: y demotes to LEAVING
        const demoted = container.querySelector('.y');
        expect(demoted).not.toBeNull();
        // The armed enter play was cancelled: no enter-family class remains on the
        // demoted element while its leave runs (a broken-proof target - a discarded
        // cancel lets the enter re-apply classes and either play finish the other's).
        expect(demoted!.className).not.toContain('route-enter');
        expect(demoted!.className).toContain('route-leave-active');

        await settle(90);
        // The leave settled exactly once: one disposal, element gone, new x in place.
        expect(log.filter((entry) => entry === 'cleanup:y')).toEqual(['cleanup:y']);
        expect(container.querySelector('.y')).toBeNull();
        expect(container.querySelectorAll('.pg').length).toBe(1);
        expect(container.querySelector('.x')).not.toBeNull();
        cleanup();
    });
});

describe('races', () =>
{
    it('(a) a rapid double navigation mid-animation flushes at the leaf slot; the layout is retained and one leaf survives', async () =>
    {
        const routes: Route[] =
        [{
            path: '/p',
            component: layoutOf('l0'),
            children:
            [
                { path: 'x', component: (): HTMLElement => h('span', { class: 'pg x' }, 'x') },
                { path: 'y', component: (): HTMLElement => h('span', { class: 'pg y' }, 'y') }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p/x', 'route');
        const layout = container.querySelector('#l0');

        router.navigate('/p/y'); // x starts leaving
        router.navigate('/p/x'); // mid-animation: the slot flushes x, demotes y, enters a new x
        expect(container.querySelectorAll('.x').length).toBe(1);

        await settle(90);
        expect(container.querySelector('#l0')).toBe(layout);
        expect(container.querySelectorAll('.pg').length).toBe(1);
        expect(container.querySelector('.x')).not.toBeNull();
        cleanup();
    });

    it('(b) a leaf mid-leave, then a LAYOUT rebuild: no orphaned leaf DOM, every root disposed', () =>
    {
        const log: string[] = [];
        const page = (name: string) => (): HTMLElement =>
        {
            onCleanup(() => log.push(`cleanup:${ name }`));
            return h('span', { class: `pg ${ name }` }, name);
        };
        const routes: Route[] =
        [
            {
                path: '/p',
                component: layoutOf('l0'),
                children:
                [
                    { path: 'x', component: page('x') },
                    { path: 'y', component: page('y') }
                ]
            },
            { path: '/q', component: (): HTMLElement => h('div', { id: 'q' }, 'q') }
        ];
        // Leaf swaps animate; the layout swap is INSTANT (function form returning null),
        // so the layout teardown happens synchronously and the ONLY thing that can reach
        // the mid-leave x at that moment is the leaf slot's own flushLeaving. Waiting for
        // a settle here would let the leave play's duration backstop reach x instead and
        // mask a skipped flush (the broken-proof control would be vacuous).
        const leafOnly: TransitionProp = (context) =>
            (context.from !== null && context.to !== null && context.from.matched[0] === context.to.matched[0] ? 'route' : null);
        const { router, container, cleanup } = mountApp(routes, '/p/x', leafOnly);

        router.navigate('/p/y'); // x mid-leave inside the leaf slot (animated)
        expect(container.querySelector('.x')).not.toBeNull();

        router.navigate('/q');   // level 0 rebuilds INSTANTLY; the cascade runs NOW
        expect(container.querySelector('#q')).not.toBeNull();

        // SYNCHRONOUS pin: the cascade reached every root inside the torn-down layout -
        // the mid-leave x through the leaf slot's own leaving set (the broken-proof control's
        // target), the active y through the branch cascade - before any timer could.
        expect(document.querySelector('#l0')).toBeNull();
        expect(document.querySelector('.x')).toBeNull();
        expect(document.querySelector('.y')).toBeNull();
        expect(log).toContain('cleanup:x');
        expect(log).toContain('cleanup:y');
        cleanup();
    });

    it('(c) an unaffected ancestor slot leave CONTINUES across an unrelated leaf navigation', async () =>
    {
        const routes: Route[] =
        [
            { path: '/solo', component: (): HTMLElement => h('main', { class: 'pg solo' }, 'solo') },
            {
                path: '/b',
                component: layoutOf('l0'),
                children:
                [
                    { path: 'x', component: (): HTMLElement => h('span', { class: 'pg x' }, 'x') },
                    { path: 'y', component: (): HTMLElement => h('span', { class: 'pg y' }, 'y') }
                ]
            }
        ];
        const { router, container, cleanup } = mountApp(routes, '/solo', 'route');

        router.navigate('/b/x'); // segment 0 rebuilds: solo leaves at the ROOT slot
        expect(container.querySelector('.solo')).not.toBeNull();

        router.navigate('/b/y'); // unrelated LEAF navigation inside the new chain
        // The ancestor's in-flight leave was not flushed by the deeper slot's swap.
        expect(container.querySelector('.solo')).not.toBeNull();
        expect(container.querySelector('#l0')).not.toBeNull();

        await settle(90);
        expect(container.querySelector('.solo')).toBeNull();
        expect(container.querySelector('#l0 .y')).not.toBeNull();
        cleanup();
    });

    it('(d) a navigation during the lazy hold supersedes it; the abandoned chunk lands harmlessly', async () =>
    {
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const routes: Route[] =
        [{
            path: '/p',
            component: layoutOf('l0'),
            children:
            [
                { path: 'warm', component: (): HTMLElement => h('em', { id: 'warm' }, 'warm') },
                { path: 'warm2', component: (): HTMLElement => h('em', { id: 'warm2' }, 'warm2') },
                { path: 'cold', lazy: () => chunk }
            ]
        }];
        const { router, container, cleanup } = mountApp(routes, '/p/warm');

        router.navigate('/p/cold');
        await flush();
        // The hold: previous screen intact.
        expect(container.querySelector('#warm')).not.toBeNull();

        router.navigate('/p/warm2');
        expect(container.querySelector('#warm2')).not.toBeNull();

        release({ default: (): HTMLElement => h('em', { id: 'cold' }, 'cold') });
        await flush();
        // Supersession: the abandoned chunk changes nothing.
        expect(container.querySelector('#cold')).toBeNull();
        expect(container.querySelector('#warm2')).not.toBeNull();
        cleanup();
    });
});

describe('driver-level (fallback <-> chain) swaps present', () =>
{
    it('match -> fallback focuses the fallback content; fallback -> match focuses segment 0', async () =>
    {
        const routes: Route[] =
        [
            { path: '/', component: (): HTMLElement => h('main', { id: 'home' }, 'home') }
        ];
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/') });
            return h('div', { id: 'app' }, Routes({ router, fallback: () => h('section', { id: 'nf' }, '404') }));
        }, container);

        router.navigate('/nowhere');
        await flush();
        expect((document.activeElement as HTMLElement | null)?.id).toBe('nf');

        router.navigate('/');
        await flush();
        expect((document.activeElement as HTMLElement | null)?.id).toBe('home');
        render(() => h('div', {}), container);
        container.remove();
    });

    it('CONTROL: the PENDING -> first-commit fill still moves no focus', async () =>
    {
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes: [{ path: '/', lazy: () => chunk }], history: createMemoryHistory('/') });
            return h('div', { id: 'app' }, Routes({ router }));
        }, container);
        const before = document.activeElement;

        release({ default: (): HTMLElement => h('main', { id: 'page' }, 'page') });
        await flush();
        expect(container.querySelector('#page')).not.toBeNull();
        expect(document.activeElement).toBe(before);
        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('the enter play dies with the branch on an INSTANT swap', () =>
{
    it('a mid-enter element torn down by a null-transition navigation carries no enter classes', async () =>
    {
        const leafOnly: TransitionProp = (context) =>
            (context.to !== null && context.to.matched[0]?.path === '/x' ? null : 'route');
        const routes: Route[] =
        [
            { path: '/a', component: (): HTMLElement => h('main', { class: 'pg a' }, 'a') },
            { path: '/b', component: (): HTMLElement => h('main', { class: 'pg b' }, 'b') },
            { path: '/x', component: (): HTMLElement => h('main', { class: 'pg x' }, 'x') }
        ];
        const { router, container, cleanup } = mountApp(routes, '/a', undefined);
        // Re-mount with the function transition (mountApp takes it directly).
        cleanup();
        const app = mountApp(routes, '/a', leafOnly);

        app.router.navigate('/b'); // b ENTERS animated
        const entering = app.container.querySelector('.b')!;
        expect(entering.className).toContain('route-enter');

        app.router.navigate('/x'); // instant swap: b is TORN DOWN mid-enter
        // The armed enter play was cancelled at teardown: the detached element's
        // family classes are stripped and no timer can re-touch it.
        expect(entering.className).not.toContain('route-enter');
        await settle(90);
        expect(entering.className).not.toContain('route-enter');
        expect(app.container.querySelector('.x')).not.toBeNull();
        app.cleanup();
        void router;
        void container;
    });
});
