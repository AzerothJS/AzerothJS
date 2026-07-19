// @vitest-environment happy-dom
//
// <Routes transition>: the outgoing route plays its leave (removal deferred)
// while the incoming mounts and plays its enter; the function form receives
// from/to/navigation for directional names; navigationKind reports what caused
// each change. End-state assertions, as in the renderer transition specs.
import { describe, it, expect } from 'vitest';
import { h, render } from '@azerothjs/renderer';
import { createRouter, Routes, createMemoryHistory } from '@azerothjs/router';
import type { RouteTransitionContext } from '@azerothjs/router';

function settle(ms = 30): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

const pages = {
    home: () => h('main', { class: 'page home' }, 'home'),
    about: () => h('main', { class: 'page about' }, 'about')
};

function setup(transition?: string | ((context: RouteTransitionContext) => string | null))
{
    const container = makeContainer();
    const router = createRouter({
        history: createMemoryHistory('/'),
        routes: [
            { path: '/', component: pages.home },
            { path: '/about', component: pages.about }
        ]
    });
    render(() => h('div', {}, Routes({ router, transition, transitionDuration: 40 })), container);
    return { container, router };
}

describe('Routes - instant swap (no transition prop)', () =>
{
    it('replaces the outgoing route immediately, as before', () =>
    {
        const { container, router } = setup();
        expect(container.querySelector('.home')).not.toBeNull();
        router.navigate('/about');
        expect(container.querySelector('.home')).toBeNull();
        expect(container.querySelector('.about')).not.toBeNull();
        container.remove();
    });
});

describe('Routes - animated swap', () =>
{
    it('keeps the outgoing route in the DOM playing leave while the incoming enters', async () =>
    {
        const { container, router } = setup('route');
        router.navigate('/about');

        // Both mounted mid-swap: outgoing with leave classes, incoming present.
        const home = container.querySelector('.home');
        expect(home).not.toBeNull();
        expect(home?.classList.contains('route-leave-active')).toBe(true);
        expect(container.querySelector('.about')).not.toBeNull();

        await settle(90);
        expect(container.querySelector('.home')).toBeNull();
        const about = container.querySelector('.about');
        expect(about).not.toBeNull();
        // Enter classes fully cleaned up after settling.
        expect(about?.classList.contains('route-enter-active')).toBe(false);
        container.remove();
    });

    it('the first render never animates', () =>
    {
        const { container } = setup('route');
        const home = container.querySelector('.home');
        expect(home?.classList.contains('route-enter-active')).toBe(false);
        container.remove();
    });

    it('a rapid second navigation flushes the still-leaving route instantly', async () =>
    {
        const { container, router } = setup('route');
        router.navigate('/about');   // home starts leaving
        router.navigate('/');        // immediately back: about leaves, old home flushed

        // Only ONE .home may exist (the flushed leaver is gone, the new one is in).
        expect(container.querySelectorAll('.home').length).toBe(1);
        await settle(90);
        expect(container.querySelectorAll('.page').length).toBe(1);
        expect(container.querySelector('.home')).not.toBeNull();
        container.remove();
    });

    it('the function form receives from, to, and the navigation kind - and null means instant', () =>
    {
        const seen: Array<{ from: string | undefined; to: string | undefined; navigation: string }> = [];
        const { container, router } = setup((context) =>
        {
            seen.push({
                from: context.from?.matched[context.from.matched.length - 1]?.path,
                to: context.to?.matched[context.to.matched.length - 1]?.path,
                navigation: context.navigation
            });
            return null; // veto: swap instantly
        });

        router.navigate('/about');
        expect(container.querySelector('.home')).toBeNull(); // instant (vetoed)
        expect(seen).toEqual([{ from: '/', to: '/about', navigation: 'push' }]);
        container.remove();
    });
});

describe('router.navigationKind', () =>
{
    it('reports push, replace, and pop honestly', () =>
    {
        const router = createRouter({
            history: createMemoryHistory('/'),
            routes: [
                { path: '/', component: pages.home },
                { path: '/about', component: pages.about }
            ]
        });
        expect(router.navigationKind()).toBe('push'); // initial default

        router.navigate('/about');
        expect(router.navigationKind()).toBe('push');

        router.replace('/');
        expect(router.navigationKind()).toBe('replace');

        router.back();
        expect(router.navigationKind()).toBe('pop');
    });
});
