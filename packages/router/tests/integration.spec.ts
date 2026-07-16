// Cross-module integration: a real router-driven app mounted into the DOM. A
// nested layout (UsersLayout + <Outlet>) wraps leaf routes; navigate() swaps the
// rendered Outlet content in place, params flow into a leaf via useParams, Link
// drives navigation by click, and useLoader data lands in the DOM. No mocks -
// real createRouter + render() + happy-dom nodes.
import { describe, it, expect } from 'vitest';
import { h, render } from '@azerothjs/renderer';
import {
    createRouter,
    createMemoryHistory,
    Routes,
    Outlet,
    Link,
    useParams,
    useLoader
} from '@azerothjs/router';
import type { Route, Router, MountNode } from '@azerothjs/router';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('router integration - nested layout app', () =>
{
    it('navigate() swaps the rendered Outlet content and params flow into the leaf', () =>
    {
        let router!: Router;

        // Leaf reads its own param reactively via useParams, rendered into a text hole.
        const UserProfile = (): HTMLElement =>
        {
            const params = useParams(router);
            return h('section', { id: 'profile' }, () => `User #${ params().id }`);
        };
        const UserList = (): HTMLElement => h('ul', { id: 'list' }, h('li', {}, 'all users'));

        const UsersLayout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'users-layout' },
                h('h2', {}, 'Users'),
                h('main', {}, Outlet({ children: props.children })));

        const Home = (): HTMLElement => h('h1', { id: 'home' }, 'Home');

        const routes: Route[] =
        [
            { path: '/', component: Home },
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

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/') });
            return h('div', { id: 'app' }, Routes({ router }));
        }, container);

        // Start on Home.
        expect(container.querySelector('#home')).not.toBeNull();
        expect(container.querySelector('#users-layout')).toBeNull();

        // Into the users index: the layout appears, list inside its <main>.
        router.navigate('/users');
        const main = container.querySelector('#users-layout main');
        expect(main).not.toBeNull();
        expect(main!.querySelector('#list')).not.toBeNull();
        expect(container.querySelector('#home')).toBeNull();

        // Into a user profile: the Outlet content swaps to the profile, param shows.
        router.navigate('/users/42');
        const profile = container.querySelector('#profile');
        expect(profile).not.toBeNull();
        expect(profile!.textContent).toBe('User #42');
        // It is nested inside the SAME layout's <main>.
        expect(container.querySelector('#users-layout main #profile')).not.toBeNull();
        expect(container.querySelector('#list')).toBeNull();

        render(() => h('div', {}), container);
        container.remove();
    });

    it('navigating between sibling params re-renders the chain and reflects the new param', () =>
    {
        let router!: Router;
        const UserProfile = (): HTMLElement =>
        {
            const params = useParams(router);
            return h('section', { id: 'profile' }, () => params().id);
        };
        const UsersLayout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, Outlet({ children: props.children }));

        const routes: Route[] =
        [
            {
                path: '/users',
                component: UsersLayout,
                children: [{ path: ':id', component: UserProfile }]
            }
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/users/1') });
            return Routes({ router });
        }, container);

        const layoutBefore = container.querySelector('#layout');
        expect(container.querySelector('#profile')!.textContent).toBe('1');

        router.navigate('/users/2');
        // A param change alters the structural match, so <Routes> re-renders the whole
        // matched chain: a FRESH layout element, with the new param in the leaf.
        expect(container.querySelector('#layout')).not.toBe(layoutBefore);
        expect(container.querySelector('#profile')!.textContent).toBe('2');

        render(() => h('div', {}), container);
        container.remove();
    });

    it('a cosmetic (hash-only) change keeps the same rendered leaf element', () =>
    {
        let router!: Router;
        const UserProfile = (): HTMLElement =>
        {
            const params = useParams(router);
            return h('section', { id: 'profile' }, () => params().id);
        };
        const routes: Route[] =
        [
            { path: '/users/:id', component: UserProfile }
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/users/1') });
            return Routes({ router });
        }, container);

        const profileBefore = container.querySelector('#profile');
        router.navigate('/users/1#bio');
        // Match is structurally equal (same route + params), so the element survives.
        expect(container.querySelector('#profile')).toBe(profileBefore);

        render(() => h('div', {}), container);
        container.remove();
    });

    it('a <Link> click navigates and the rendered route swaps', () =>
    {
        let router!: Router;
        const Home = (): HTMLElement =>
            h('div', { id: 'home' },
                Link({ to: '/about', router, id: 'to-about', children: 'About' }));
        const About = (): HTMLElement => h('div', { id: 'about' }, 'About page');

        const routes: Route[] =
        [
            { path: '/', component: Home },
            { path: '/about', component: About }
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/') });
            return Routes({ router });
        }, container);

        expect(container.querySelector('#home')).not.toBeNull();
        const link = container.querySelector('#to-about') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/about');

        const ev = new MouseEvent('click', { button: 0, cancelable: true, bubbles: true });
        const guard = (e: Event): void => e.preventDefault();
        link.addEventListener('click', guard);
        link.dispatchEvent(ev);
        link.removeEventListener('click', guard);

        expect(router.location().pathname).toBe('/about');
        expect(container.querySelector('#home')).toBeNull();
        expect(container.querySelector('#about')).not.toBeNull();

        render(() => h('div', {}), container);
        container.remove();
    });

    it('useLoader data lands in the DOM and refreshes on navigation', async () =>
    {
        let router!: Router;
        const UserPage = (): HTMLElement =>
        {
            const data = useLoader<string>(router);
            return h('section', { id: 'user' }, () =>
                data.loading() ? 'loading' : (data.data() ?? 'none'));
        };
        const routes: Route[] =
        [
            {
                path: '/users/:id',
                component: UserPage,
                loader: async ({ params }) => `name-${ params.id }`
            }
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/users/1') });
            return Routes({ router });
        }, container);

        // Synchronously loading on first paint.
        expect(container.querySelector('#user')!.textContent).toBe('loading');
        await flush();
        expect(container.querySelector('#user')!.textContent).toBe('name-1');

        router.navigate('/users/2');
        expect(container.querySelector('#user')!.textContent).toBe('loading');
        await flush();
        expect(container.querySelector('#user')!.textContent).toBe('name-2');

        render(() => h('div', {}), container);
        container.remove();
    });

    it('renders a 404 fallback for an unmatched URL, then recovers on navigation', () =>
    {
        let router!: Router;
        const routes: Route[] =
        [
            { path: '/', component: () => h('div', { id: 'home' }, 'home') }
        ];

        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/missing') });
            return Routes({ router, fallback: () => h('div', { id: 'nf' }, 'Not found') });
        }, container);

        expect(container.querySelector('#nf')).not.toBeNull();
        expect(container.querySelector('#home')).toBeNull();

        router.navigate('/');
        expect(container.querySelector('#nf')).toBeNull();
        expect(container.querySelector('#home')).not.toBeNull();

        render(() => h('div', {}), container);
        container.remove();
    });
});
