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

import { defineComponent, h, onDestroy } from '@azerothjs/core';
import {
    createRouter,
    Link,
    Routes,
    Outlet,
    useParams,
    useNavigate,
    useRoute,
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

export const RouterDemo = defineComponent(() =>
{
    // Forward declaration — assigned below by createRouter().
    // Route components close over this variable and read it lazily
    // when they're invoked by `<Routes>` (well after createRouter
    // has returned).
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
            )
        );

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
        const params = useParams(router);
        return h('div', {},
            h('p', { class: 'router-demo-bio' }, () =>
            {
                const u = findUser(params().id);
                return u ? u.bio : 'No user with this id.';
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
                    {
                        path: ':id',
                        component: UserLayout,
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
                { class: 'btn-secondary', onClick: () => forward() },
                'Forward →'
            ),
            h('div', { class: 'router-demo-url' },
                'URL: ',
                h('code', {}, () => location().fullPath || '/')
            )
        ),

        Routes({ router, fallback: NotInDemo })
    );
});
