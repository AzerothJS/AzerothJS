// ============================================================================
// AZEROTHJS — Router Demo
// ============================================================================
//
// A small but representative tour of @azerothjs/router. Exercises:
//   - createRouter with nested routes
//   - <Link> with reactive activeClass
//   - <Routes> dispatcher with 404 fallback
//   - <Outlet> inside a layout component
//   - useParams composable for slice-memoized params
//   - useNavigate for back/forward navigation
//   - useRoute for the live URL display
//   - Route.loader + useLoader — async data with cancellation
//   - <ErrorBoundary> wrapping the route tree as a safety net
//   - <Suspense> on the router's loader for "loading…" UI
//
// IMPORTANT: this demo drives the real URL bar. When you click a
// link below, the address bar genuinely changes — that's the
// router doing its job. Refreshing on a deep URL (e.g.
// /router-demo/2) works because Vite's dev server falls back to
// index.html for unknown routes.
//
// FORWARD-DECLARATION PATTERN:
//
//   Route components need a `Router` reference (Link's `router`
//   prop) but the router is built from those same components.
//   The chicken-and-egg is resolved by forward-declaring `let
//   router` and letting closures capture the variable. By the
//   time a component renders, `router` is already assigned.
//
// ============================================================================

import { defineComponent, h, onDestroy, ErrorBoundary, Suspense } from '@azerothjs/core';
import {
    createRouter,
    Link,
    Routes,
    Outlet,
    useParams,
    useNavigate,
    useRoute,
    useLoader,
    type RouteComponent,
    type Router
} from '@azerothjs/router';

// ── Fixture data ─────────────────────────────────────────────

interface DemoUser
{
    id: string;
    name: string;
    bio: string;
    posts: Array<{ slug: string; title: string; body: string }>;
}

const users: DemoUser[] =
[
    {
        id: '1',
        name: 'Ada Lovelace',
        bio: 'Mathematician and the first computer programmer.',
        posts:
        [
            {
                slug: 'analytical-engine',
                title: 'On the Analytical Engine',
                body: 'A general-purpose machine is more than the sum of its tables.'
            },
            {
                slug: 'translation-notes',
                title: 'Translator\'s Notes',
                body: 'Footnotes can be longer than the article they annotate.'
            }
        ]
    },
    {
        id: '2',
        name: 'Alan Turing',
        bio: 'Father of theoretical computer science and AI.',
        posts:
        [
            {
                slug: 'imitation-game',
                title: 'The Imitation Game',
                body: 'Can machines think? The right question is what counts as thinking.'
            }
        ]
    },
    {
        id: '3',
        name: 'Grace Hopper',
        bio: 'Pioneer of compiler design and creator of FLOW-MATIC.',
        posts:
        [
            {
                slug: 'compilers',
                title: 'Why we need compilers',
                body: 'It is easier to apologise than it is to get permission.'
            }
        ]
    }
];

function findUser(id: string): DemoUser | undefined
{
    return users.find(u => u.id === id);
}

/**
 * Simulates a network fetch — resolves with the user (or rejects
 * with a "not found" error) after a 300 ms delay. Honours the
 * `AbortSignal` so a navigation away cancels the in-flight load.
 *
 * Demonstrates the resource's race-condition guard: rapid clicks
 * between users abort the previous load, and only the latest
 * resolved data ever paints to the UI.
 */
function loadUser(id: string, signal: AbortSignal): Promise<DemoUser>
{
    return new Promise<DemoUser>((resolve, reject) =>
    {
        const timer = setTimeout(() =>
        {
            const u = findUser(id);
            if (!u) reject(new Error(`No user with id "${ id }"`));
            else resolve(u);
        }, 300);

        // If the navigation is superseded mid-flight, the resource
        // aborts our signal — clean up the pending timer so we
        // don't sit on it for nothing.
        signal.addEventListener('abort', () =>
        {
            clearTimeout(timer);
            reject(new Error('aborted'));
        });
    });
}

export const RouterDemo = defineComponent(() =>
{
    // Forward declaration — assigned below by createRouter().
    // Route components close over this variable and read it lazily
    // when they're invoked by `<Routes>` (well after createRouter
    // has returned). prefer-const sees only one assignment site
    // and suggests const, but we need the binding in scope BEFORE
    // the assignment so closures can capture it.
    // eslint-disable-next-line prefer-const
    let router!: Router;

    // ── Route components ─────────────────────────────────────

    const UserList: RouteComponent = () =>
        h('div', { class: 'router-demo-page' },
            h('h4', {}, 'Pick a user'),
            h('ul', { class: 'router-demo-list' },
                ...users.map(u =>
                    h('li', {},
                        Link({
                            to: `/router-demo/${ u.id }`,
                            router,
                            class: 'router-demo-list-link',
                            activeClass: 'router-demo-list-link--active',
                            children: u.name
                        }),
                        h('span', { class: 'router-demo-list-bio' }, u.bio)
                    )
                )
            ),
            h('p', { class: 'router-demo-bio' },
                Link({
                    to: '/router-demo/broken',
                    router,
                    class: 'router-demo-cta',
                    children: 'Test ErrorBoundary →'
                })
            )
        );

    /**
     * A route that intentionally throws on its first render so we
     * can demonstrate the wrapping `ErrorBoundary` swapping in a
     * fallback. The `attempts` counter resets the throw on retry,
     * so the boundary's `reset()` actually recovers — clicking
     * "Try again" succeeds the second time around.
     *
     * Note: the throw is SYNCHRONOUS during the render. Errors
     * from `useLoader().error()` are async and observable; the
     * boundary doesn't catch those — the route's component reads
     * them directly. See the UserOverview component above for
     * that style.
     */
    let brokenAttempts = 0;
    const BrokenPage: RouteComponent = () =>
    {
        brokenAttempts++;
        if (brokenAttempts === 1)
        {
            throw new Error('Intentional render failure (try again to recover)');
        }
        const div = document.createElement('div');
        div.className = 'router-demo-page';
        div.innerHTML =
            '<h4>Recovered ✓</h4>' +
            '<p class="router-demo-bio">' +
            'The boundary caught the first throw and rendered its fallback. ' +
            'Clicking "Try again" reset the boundary, which re-rendered this ' +
            'route — this time without throwing.</p>';
        return div;
    };

    const UserLayout: RouteComponent = ({ children }) =>
    {
        const params = useParams(router);

        return h('div', { class: 'router-demo-page' },
            h('h4', {},
                'User detail: ',
                h('code', {}, () =>
                {
                    const u = findUser(params().id);
                    return u ? u.name : `(unknown id "${ params().id }")`;
                })
            ),

            // Tab strip: an Overview link plus one link per post.
            // The post links list updates when the user changes —
            // we wrap the tab construction in a reactive child so
            // it re-renders on params change.
            h('nav', { class: 'router-demo-tabs' }, () =>
            {
                const id = params().id;
                const u = findUser(id);
                const tabContainer = document.createElement('div');
                tabContainer.style.display = 'contents';

                tabContainer.appendChild(
                    Link({
                        to: `/router-demo/${ id }`,
                        router,
                        class: 'router-demo-tab',
                        activeClass: 'router-demo-tab--active',
                        children: 'Overview'
                    })
                );

                for (const p of u?.posts ?? [])
                {
                    tabContainer.appendChild(
                        Link({
                            to: `/router-demo/${ id }/posts/${ p.slug }`,
                            router,
                            class: 'router-demo-tab',
                            activeClass: 'router-demo-tab--active',
                            children: p.title
                        })
                    );
                }

                return tabContainer;
            }),

            h('div', { class: 'router-demo-outlet' }, Outlet({ children }))
        );
    };

    const UserOverview: RouteComponent = () =>
    {
        // useLoader returns the matched route's loader resource.
        // We type-cast via the generic argument — the router can't
        // know which leaf's loader is active at compile time.
        //
        // The "loading" branch is intentionally absent — Suspense
        // around the route tree (see below) gates all rendering on
        // `router.loader.loading`, so by the time this component
        // appears in the DOM we know the loader has settled.
        const user = useLoader<DemoUser>(router);

        return h('div', {},
            h('p', { class: 'router-demo-bio' }, () =>
            {
                const err = user.error();
                if (err) return `Error: ${ err instanceof Error ? err.message : String(err) }`;
                const u = user.data();
                return u ? u.bio : 'No user data.';
            })
        );
    };

    const PostPage: RouteComponent = () =>
    {
        const params = useParams(router);
        return h('div', { class: 'router-demo-post' },
            h('h5', {}, () =>
            {
                const u = findUser(params().id);
                const p = u?.posts.find(post => post.slug === params().slug);
                return p?.title ?? 'Post not found';
            }),
            h('p', { class: 'router-demo-bio' }, () =>
            {
                const u = findUser(params().id);
                const p = u?.posts.find(post => post.slug === params().slug);
                return p?.body ?? '';
            })
        );
    };

    /**
     * Catch-all when the URL is outside the demo's `/router-demo`
     * subtree (typically when the page first opens at `/`).
     * Provides an obvious way in.
     */
    const NotInDemo = (): HTMLElement =>
        h('div', { class: 'router-demo-empty' },
            h('p', {}, 'You\'re not currently inside the router demo.'),
            Link({
                to: '/router-demo',
                router,
                class: 'router-demo-cta',
                children: 'Enter the router demo →'
            })
        );

    // ── Build the router ─────────────────────────────────────
    //
    // The wrapper layout for `/router-demo` just forwards its
    // children — it exists only because nested routes need a
    // parent. (In real apps the parent layout usually owns site
    // chrome; here we keep it invisible so the demo card holds
    // everything.)

    router = createRouter({
        routes:
        [
            {
                path: '/router-demo',
                component: ({ children }) =>
                {
                    const wrapper = document.createElement('span');
                    wrapper.style.display = 'contents';
                    if (children) wrapper.appendChild(children);
                    return wrapper;
                },
                children:
                [
                    { path: '', component: UserList },
                    { path: 'broken', component: BrokenPage },
                    {
                        path: ':id',
                        component: UserLayout,
                        // The loader runs whenever the matched
                        // route's params change. Switching users
                        // triggers a new fetch + aborts the old.
                        loader: ({ params, signal }) =>
                            loadUser(params.id, signal),
                        children:
                        [
                            { path: '', component: UserOverview },
                            { path: 'posts/:slug', component: PostPage }
                        ]
                    }
                ]
            }
        ]
    });

    // ── Toolbar wiring ───────────────────────────────────────

    const { back, forward } = useNavigate(router);
    const location = useRoute(router);

    onDestroy(() =>
    {
        // Toggleable wraps us in a createRoot, so the router's
        // popstate subscription is torn down by the root disposer.
        // The log just makes the lifecycle visible in DevTools.
        console.log('🚪 RouterDemo unmounted — popstate listener detached.');
    });

    return h('div', { class: 'router-demo' },
        h('div', { class: 'router-demo-toolbar' },
            h('button',
                { class: 'btn-ghost', onClick: () => back() },
                '← Back'
            ),
            h('button',
                { class: 'btn-ghost', onClick: () => forward() },
                'Forward →'
            ),
            h('div', { class: 'router-demo-url' },
                'URL: ',
                h('code', {}, () => location().fullPath || '/')
            )
        ),

        // The whole route tree is wrapped in an ErrorBoundary so a
        // single broken route can't take the rest of the demo down
        // with it. Try clicking "Test ErrorBoundary →" inside the
        // user list to see this in action.
        //
        // Suspense sits INSIDE the ErrorBoundary and watches the
        // router's loader resource. Switching users triggers the
        // 300 ms simulated fetch; while it's pending, Suspense
        // shows a "Loading…" line in place of the matched route.
        // When the loader settles (or errors), Suspense flips back
        // to the route content. This is what makes per-route
        // components free to assume their loader has resolved by
        // the time they render.
        ErrorBoundary({
            fallback: (err, reset) =>
                h('div', { class: 'router-demo-page' },
                    h('h4', { class: 'router-demo-error-title' }, 'Something went wrong'),
                    h('p', { class: 'router-demo-bio' },
                        err instanceof Error ? err.message : String(err)
                    ),
                    h('button',
                        { class: 'btn-ghost', onClick: reset },
                        'Try again'
                    )
                ),
            children: () => Suspense({
                fallback: () =>
                    h('p', { class: 'router-demo-bio router-demo-suspense' }, 'Loading…'),
                on: [router.loader],
                children: () => Routes({ router, fallback: NotInDemo })
            })
        })
    );
});
