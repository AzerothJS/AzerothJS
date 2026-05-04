import { describe, it, expect, beforeEach } from 'vitest';
import { createRoot } from '@azerothjs/core';
import { createRouter } from '../../packages/router/src/router.ts';
import type { Route, RouteComponent } from '../../packages/router/src/types.ts';

// ── Test fixtures ────────────────────────────────────────────
//
// Real DOM-returning components aren't needed for these tests —
// we only check route matching, params, and reactivity. Each
// "component" here is a stable function reference used for
// assertions like `expect(match.route.component).toBe(Home)`.

const Home: RouteComponent = () => document.createElement('div');
const About: RouteComponent = () => document.createElement('div');
const UsersLayout: RouteComponent = () => document.createElement('div');
const UserList: RouteComponent = () => document.createElement('div');
const UserProfile: RouteComponent = () => document.createElement('div');
const PostPage: RouteComponent = () => document.createElement('div');

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
            { path: ':id', component: UserProfile },
            { path: ':id/posts/:slug', component: PostPage }
        ]
    }
];

describe('createRouter', () =>
{
    beforeEach(() =>
    {
        // Each test starts from the same known URL so the
        // initial-state assertions are deterministic.
        window.history.replaceState({}, '', '/initial');
    });

    // ── Construction ─────────────────────────────────────────

    it('matches the leaf route at the current URL on construction', () =>
    {
        window.history.replaceState({}, '', '/about');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            const m = router.match();

            expect(m).not.toBeNull();
            expect(m!.route.component).toBe(About);
            expect(m!.matched).toEqual([{ path: '/about', component: About }]);

            dispose();
        });
    });

    it('returns null when no route matches', () =>
    {
        window.history.replaceState({}, '', '/no-such-page');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            expect(router.match()).toBeNull();
            dispose();
        });
    });

    // ── Reactive matching ────────────────────────────────────

    it('updates match() after navigate()', () =>
    {
        window.history.replaceState({}, '', '/');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            expect(router.match()!.route.component).toBe(Home);

            router.navigate('/about');
            expect(router.match()!.route.component).toBe(About);

            dispose();
        });
    });

    it('returns the full root → leaf chain for a nested match', () =>
    {
        window.history.replaceState({}, '', '/users/42');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            const m = router.match();

            expect(m).not.toBeNull();
            // Chain length: the parent layout route plus the leaf.
            expect(m!.matched).toHaveLength(2);
            expect(m!.matched[0].component).toBe(UsersLayout);
            expect(m!.matched[1].component).toBe(UserProfile);
            expect(m!.route.component).toBe(UserProfile);

            dispose();
        });
    });

    it('merges params across nested patterns into one object', () =>
    {
        window.history.replaceState({}, '', '/users/42/posts/hello-world');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            const m = router.match();
            const loc = router.location();

            expect(m!.params).toEqual({ id: '42', slug: 'hello-world' });
            // location.params mirrors the match's params.
            expect(loc.params).toEqual({ id: '42', slug: 'hello-world' });

            dispose();
        });
    });

    // ── Navigation ───────────────────────────────────────────

    it('updates location.fullPath after navigating with a string target', () =>
    {
        window.history.replaceState({}, '', '/');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });

            router.navigate('/users/42?tab=posts#bio');
            const loc = router.location();

            expect(loc.pathname).toBe('/users/42');
            expect(loc.search).toBe('?tab=posts');
            expect(loc.hash).toBe('#bio');
            expect(loc.fullPath).toBe('/users/42?tab=posts#bio');
            expect(loc.query).toEqual({ tab: 'posts' });

            dispose();
        });
    });

    it('builds the URL from a structured navigate target', () =>
    {
        window.history.replaceState({}, '', '/');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });

            router.navigate({
                pathname: '/users/42',
                query: { tab: 'posts', filter: 'recent' },
                // Caller forgot the leading '#' — router adds it.
                hash: 'bio'
            });

            const loc = router.location();
            expect(loc.pathname).toBe('/users/42');
            expect(loc.search).toBe('?tab=posts&filter=recent');
            expect(loc.hash).toBe('#bio');

            dispose();
        });
    });

    it('updates location after replace()', () =>
    {
        window.history.replaceState({}, '', '/');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            router.navigate('/about');
            router.replace('/users/42');

            // We can't assert stack length in happy-dom, so we
            // only verify the visible effect: location updated.
            expect(router.location().pathname).toBe('/users/42');

            dispose();
        });
    });

    it('reacts to a manual popstate event (back/forward simulation)', () =>
    {
        window.history.replaceState({}, '', '/');

        createRoot((dispose) =>
        {
            const router = createRouter({ routes });
            expect(router.location().pathname).toBe('/');

            // Simulate a back/forward navigation from outside the
            // router's own navigate() path.
            window.history.replaceState({}, '', '/users/42');
            window.dispatchEvent(new PopStateEvent('popstate'));

            expect(router.location().pathname).toBe('/users/42');
            expect(router.match()!.route.component).toBe(UserProfile);

            dispose();
        });
    });

    // ── Cleanup ──────────────────────────────────────────────

    it('unsubscribes from history when the owning root is disposed', () =>
    {
        window.history.replaceState({}, '', '/');

        let routerRef!: ReturnType<typeof createRouter>;

        createRoot((dispose) =>
        {
            routerRef = createRouter({ routes });
            expect(routerRef.location().pathname).toBe('/');
            dispose();
        });

        // After dispose, the popstate listener should be detached
        // from the router's adapter — a subsequent URL change
        // must NOT update the (now-frozen) location signal.
        window.history.replaceState({}, '', '/about');
        window.dispatchEvent(new PopStateEvent('popstate'));

        expect(routerRef.location().pathname).toBe('/');
    });

    it('lets two routers in nested roots dispose independently', () =>
    {
        window.history.replaceState({}, '', '/');

        let outerRouter!: ReturnType<typeof createRouter>;
        let innerRouter!: ReturnType<typeof createRouter>;

        createRoot((disposeOuter) =>
        {
            outerRouter = createRouter({ routes });

            createRoot((disposeInner) =>
            {
                innerRouter = createRouter({ routes });

                // Both observe the current URL.
                expect(outerRouter.location().pathname).toBe('/');
                expect(innerRouter.location().pathname).toBe('/');

                // Dispose the inner router only.
                disposeInner();
            });

            // After disposing the inner, only the outer router
            // should still react to URL changes.
            window.history.replaceState({}, '', '/about');
            window.dispatchEvent(new PopStateEvent('popstate'));

            expect(outerRouter.location().pathname).toBe('/about');
            expect(innerRouter.location().pathname).toBe('/'); // frozen

            disposeOuter();
        });
    });
});
