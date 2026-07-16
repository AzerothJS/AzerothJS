// Full behavioral coverage for <Routes> (routes.ts): renders the matched route
// chain into the DOM, swaps content (disposing the old branch) on match change,
// nests layouts via the wrapped children chain, and renders the fallback (or
// nothing) when no route matches. Real render() into happy-dom, real router on
// memory history - no mocks.
import { describe, it, expect } from 'vitest';
import { onCleanup } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';
import { createRouter, createMemoryHistory, Routes, Outlet, type MountNode } from '@azerothjs/router';
import type { Route, Router } from '@azerothjs/router';

const Home = (): HTMLElement => h('h1', { id: 'home' }, 'Home');
const About = (): HTMLElement => h('h1', { id: 'about' }, 'About');

const UsersLayout = (props: { children?: MountNode | undefined }): MountNode =>
    h('div', { id: 'users-layout' }, h('header', {}, 'Users'), Outlet({ children: props.children }));
const UserList = (): HTMLElement => h('ul', { id: 'user-list' }, h('li', {}, 'list'));
const UserProfile = (): HTMLElement => h('section', { id: 'user-profile' }, 'profile');

const NotFound = (): HTMLElement => h('h1', { id: 'not-found' }, '404');

const routes: Route[] =
[
    { path: '/', component: Home },
    { path: '/about', component: About },
    {
        path: '/users',
        component: UsersLayout,
        children:
        [
            { path: '', component: UserList },
            { path: ':id', component: UserProfile }
        ]
    }
];

// Mounts a Routes-driven app, returning the router, the container, and a teardown.
// Everything runs under render()'s root so the router subscription is owned.
function mountRoutes(initialUrl: string, fallback?: () => HTMLElement): { router: Router; container: HTMLElement; cleanup: () => void }
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
            render(() => h('div', {}), container); // dispose previous mount
            container.remove();
        }
    };
}

describe('Routes - initial render', () =>
{
    it('renders the matched leaf component', () =>
    {
        const { container, cleanup } = mountRoutes('/about');
        expect(container.querySelector('#about')).not.toBeNull();
        expect(container.querySelector('#home')).toBeNull();
        cleanup();
    });

    it('renders the index route at "/"', () =>
    {
        const { container, cleanup } = mountRoutes('/');
        expect(container.querySelector('#home')).not.toBeNull();
        cleanup();
    });

    it('renders a nested layout wrapping its child (nested index)', () =>
    {
        const { container, cleanup } = mountRoutes('/users');
        const layout = container.querySelector('#users-layout');
        expect(layout).not.toBeNull();
        // The list renders INSIDE the layout via Outlet.
        expect(layout!.querySelector('#user-list')).not.toBeNull();
        cleanup();
    });

    it('renders a nested param route inside the layout', () =>
    {
        const { container, cleanup } = mountRoutes('/users/42');
        const layout = container.querySelector('#users-layout');
        expect(layout).not.toBeNull();
        expect(layout!.querySelector('#user-profile')).not.toBeNull();
        cleanup();
    });
});

describe('Routes - reactive swaps', () =>
{
    it('swaps content when the route changes', () =>
    {
        const { router, container, cleanup } = mountRoutes('/');
        expect(container.querySelector('#home')).not.toBeNull();

        router.navigate('/about');
        expect(container.querySelector('#home')).toBeNull();
        expect(container.querySelector('#about')).not.toBeNull();

        router.navigate('/users');
        expect(container.querySelector('#about')).toBeNull();
        expect(container.querySelector('#user-list')).not.toBeNull();
        cleanup();
    });

    it('swaps between nested leaves under the same layout when params change', () =>
    {
        const { router, container, cleanup } = mountRoutes('/users');
        expect(container.querySelector('#user-list')).not.toBeNull();

        router.navigate('/users/1');
        expect(container.querySelector('#user-list')).toBeNull();
        expect(container.querySelector('#user-profile')).not.toBeNull();
        cleanup();
    });

    it('does NOT re-render on a cosmetic (hash-only) URL change', () =>
    {
        const { router, container, cleanup } = mountRoutes('/users/42');
        const profileBefore = container.querySelector('#user-profile');
        expect(profileBefore).not.toBeNull();

        router.navigate('/users/42#bio');
        // Same element instance survives - the structural match memo did not change.
        expect(container.querySelector('#user-profile')).toBe(profileBefore);
        cleanup();
    });

    it('disposes the leaving branch (its onCleanup fires) on swap', () =>
    {
        const cleaned: string[] = [];
        const Tracked = (): HTMLElement =>
        {
            onCleanup(() => cleaned.push('tracked'));
            return h('div', { id: 'tracked' }, 'tracked');
        };
        const trackedRoutes: Route[] =
        [
            { path: '/', component: () => h('div', { id: 'root' }, 'root') },
            { path: '/tracked', component: Tracked }
        ];
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        render(() =>
        {
            router = createRouter({ routes: trackedRoutes, history: createMemoryHistory('/tracked') });
            return Routes({ router });
        }, container);

        expect(container.querySelector('#tracked')).not.toBeNull();
        expect(cleaned).toEqual([]);

        router.navigate('/');
        expect(cleaned).toEqual(['tracked']);
        expect(container.querySelector('#tracked')).toBeNull();

        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('Routes - fallback (no match)', () =>
{
    it('renders the fallback when no route matches', () =>
    {
        const { container, cleanup } = mountRoutes('/does-not-exist', () => NotFound());
        expect(container.querySelector('#not-found')).not.toBeNull();
        cleanup();
    });

    it('renders nothing matched-related when no route matches and no fallback', () =>
    {
        const { container, cleanup } = mountRoutes('/does-not-exist');
        expect(container.querySelector('#home')).toBeNull();
        expect(container.querySelector('#about')).toBeNull();
        expect(container.querySelector('#not-found')).toBeNull();
        cleanup();
    });

    it('swaps from a match into the fallback when navigating to a non-match', () =>
    {
        const { router, container, cleanup } = mountRoutes('/about', () => NotFound());
        expect(container.querySelector('#about')).not.toBeNull();

        router.navigate('/nope');
        expect(container.querySelector('#about')).toBeNull();
        expect(container.querySelector('#not-found')).not.toBeNull();
        cleanup();
    });

    it('swaps from the fallback back into a real route', () =>
    {
        const { router, container, cleanup } = mountRoutes('/nope', () => NotFound());
        expect(container.querySelector('#not-found')).not.toBeNull();

        router.navigate('/about');
        expect(container.querySelector('#not-found')).toBeNull();
        expect(container.querySelector('#about')).not.toBeNull();
        cleanup();
    });
});
