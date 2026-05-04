import { describe, it, expect } from 'vitest';
import { createRoot } from '@azerothjs/core';
import { h } from '@azerothjs/renderer';
import { createRouter } from '../../packages/router/src/router.ts';
import { Routes } from '../../packages/router/src/routes.ts';
import { Outlet } from '../../packages/router/src/outlet.ts';
import type { RouteComponent } from '../../packages/router/src/types.ts';

describe('<Outlet>', () =>
{
    it('returns props.children when children are provided', () =>
    {
        const child = document.createElement('section');
        child.setAttribute('data-child', 'true');

        const result = Outlet({ children: child });

        // Reference identity — Outlet is a pure passthrough.
        expect(result).toBe(child);
    });

    it('returns an empty display:contents placeholder when children is absent', () =>
    {
        const result = Outlet({});

        expect(result.tagName).toBe('SPAN');
        expect(result.style.display).toBe('contents');
        expect(result.children.length).toBe(0);
    });

    it('integrates with <Routes>: a layout using <Outlet> renders the nested level', () =>
    {
        window.history.replaceState({}, '', '/users/42');

        // Layout component places <Outlet> inside a <main>. The
        // nested route's element should land there, not at the
        // layout's root.
        const AppLayout: RouteComponent = ({ children }) =>
            h('div', { class: 'app' },
                h('header', { 'data-region': 'header' }, 'App'),
                h('main', { 'data-region': 'main' }, Outlet({ children }))
            );

        const UserPage: RouteComponent = () =>
        {
            const div = document.createElement('div');
            div.setAttribute('data-leaf', 'user');
            div.textContent = 'User profile';
            return div;
        };

        createRoot((dispose) =>
        {
            const router = createRouter({
                routes:
                [
                    {
                        path: '/users',
                        component: AppLayout,
                        children: [{ path: ':id', component: UserPage }]
                    }
                ]
            });
            const container = Routes({ router });

            const main = container.querySelector('[data-region="main"]');
            expect(main).not.toBeNull();

            // The user leaf must live inside <main>, not adjacent
            // to it — that's the whole job of <Outlet>.
            const leaf = main!.querySelector('[data-leaf="user"]');
            expect(leaf).not.toBeNull();
            expect(leaf!.textContent).toBe('User profile');

            // And conversely: the leaf must NOT appear inside the
            // header.
            const header = container.querySelector('[data-region="header"]');
            expect(header!.querySelector('[data-leaf="user"]')).toBeNull();

            dispose();
        });
    });
});
