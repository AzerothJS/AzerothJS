import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from '@azerothjs/core';
import { defineComponent, onDestroy } from '@azerothjs/component';
import { createRouter } from '../../packages/router/src/router.ts';
import { Routes } from '../../packages/router/src/routes.ts';
import type { RouteComponent } from '../../packages/router/src/types.ts';

// ── Component factories ──────────────────────────────────────
//
// Layouts wrap their children — leaves return a leaf div. Both
// expose a `data-*` attribute so DOM assertions can target them.

function makeLeaf(name: string): RouteComponent
{
    return (): HTMLElement =>
    {
        const div = document.createElement('div');
        div.setAttribute('data-leaf', name);
        div.textContent = name;
        return div;
    };
}

function makeLayout(name: string): RouteComponent
{
    return ({ children }): HTMLElement =>
    {
        const div = document.createElement('div');
        div.setAttribute('data-layout', name);
        if (children)
        {
            div.appendChild(children);
        }
        return div;
    };
}

describe('<Routes>', () =>
{
    beforeEach(() =>
    {
        window.history.replaceState({}, '', '/initial');
    });

    // ── Chain wrapping ───────────────────────────────────────

    it('renders the matched leaf when the chain has length 1', () =>
    {
        window.history.replaceState({}, '', '/about');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: makeLeaf('about') }]
            });
            const container = Routes({ router });

            expect(container.querySelector('[data-leaf="about"]')).not.toBeNull();

            dispose();
        });
    });

    it('wraps a leaf inside its layout when the chain has 2 levels', () =>
    {
        window.history.replaceState({}, '', '/users/42');

        createRoot((dispose) =>
        {
            const usersLayout = makeLayout('users');
            const userProfile = makeLeaf('user-profile');

            const router = createRouter({
                routes:
                [
                    {
                        path: '/users',
                        component: usersLayout,
                        children: [{ path: ':id', component: userProfile }]
                    }
                ]
            });
            const container = Routes({ router });

            const layout = container.querySelector('[data-layout="users"]');
            expect(layout).not.toBeNull();

            const leaf = layout!.querySelector('[data-leaf="user-profile"]');
            expect(leaf).not.toBeNull();

            dispose();
        });
    });

    it('wraps a leaf inside two layouts when the chain has 3 levels', () =>
    {
        window.history.replaceState({}, '', '/admin/users/42');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes:
                [
                    {
                        path: '/',
                        component: makeLayout('app'),
                        children:
                        [
                            {
                                path: '/admin',
                                component: makeLayout('admin'),
                                children: [{ path: 'users/:id', component: makeLeaf('user') }]
                            }
                        ]
                    }
                ]
            });
            const container = Routes({ router });

            const appLayout = container.querySelector('[data-layout="app"]');
            const adminLayout = appLayout!.querySelector('[data-layout="admin"]');
            const userLeaf = adminLayout!.querySelector('[data-leaf="user"]');

            expect(appLayout).not.toBeNull();
            expect(adminLayout).not.toBeNull();
            expect(userLeaf).not.toBeNull();

            dispose();
        });
    });

    // ── Reactive swap ────────────────────────────────────────

    it('swaps content when the route changes', () =>
    {
        window.history.replaceState({}, '', '/about');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes:
                [
                    { path: '/about',   component: makeLeaf('about') },
                    { path: '/contact', component: makeLeaf('contact') }
                ]
            });
            const container = Routes({ router });

            expect(container.querySelector('[data-leaf="about"]')).not.toBeNull();
            expect(container.querySelector('[data-leaf="contact"]')).toBeNull();

            router.navigate('/contact');

            expect(container.querySelector('[data-leaf="about"]')).toBeNull();
            expect(container.querySelector('[data-leaf="contact"]')).not.toBeNull();

            dispose();
        });
    });

    it('runs onDestroy on the leaving component during a swap', () =>
    {
        window.history.replaceState({}, '', '/a');

        const destroyA = vi.fn();
        const PageA = defineComponent<{ children?: HTMLElement }>(() =>
        {
            onDestroy(destroyA);
            const div = document.createElement('div');
            div.setAttribute('data-leaf', 'a');
            return div;
        });

        const PageB: RouteComponent = makeLeaf('b');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes:
                [
                    { path: '/a', component: PageA },
                    { path: '/b', component: PageB }
                ]
            });
            Routes({ router });

            expect(destroyA).not.toHaveBeenCalled();

            router.navigate('/b');

            expect(destroyA).toHaveBeenCalledOnce();

            dispose();
        });
    });

    // ── Fallback ─────────────────────────────────────────────

    it('renders fallback when no route matches', () =>
    {
        window.history.replaceState({}, '', '/no-such-route');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: makeLeaf('about') }]
            });
            const container = Routes({
                router,
                fallback: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-fallback', 'true');
                    div.textContent = '404';
                    return div;
                }
            });

            expect(container.querySelector('[data-fallback="true"]')).not.toBeNull();
            expect(container.textContent).toContain('404');

            dispose();
        });
    });

    it('renders nothing when no route matches and no fallback is provided', () =>
    {
        window.history.replaceState({}, '', '/no-such-route');

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: makeLeaf('about') }]
            });
            const container = Routes({ router });

            expect(container.children.length).toBe(0);
            expect(container.textContent).toBe('');

            dispose();
        });
    });

    // ── Slice efficiency ─────────────────────────────────────

    it('does NOT re-render when only the hash changes', () =>
    {
        window.history.replaceState({}, '', '/about');

        let renderCount = 0;
        const About: RouteComponent = () =>
        {
            renderCount++;
            const div = document.createElement('div');
            div.setAttribute('data-leaf', 'about');
            return div;
        };

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: About }]
            });
            Routes({ router });

            expect(renderCount).toBe(1);

            // Hash-only change — match memo's structural equality
            // sees the same route + same params and stays quiet.
            router.navigate('/about#bio');

            expect(renderCount).toBe(1);

            // Sanity — a real route change DOES re-render.
            router.navigate('/about?x=1#bio');
            expect(renderCount).toBe(1); // query change also leaves match alone

            dispose();
        });
    });
});
