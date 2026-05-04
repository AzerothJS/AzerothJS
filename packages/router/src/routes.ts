// ============================================================================
// AZEROTHJS — <Routes> Dispatcher
// ============================================================================
//
// `<Routes>` is the bridge between a `Router` and the DOM. It
// reads `router.match()` reactively, renders the matched route
// chain (layouts wrapping leaves), and swaps content cleanly when
// the match changes.
//
// WHY THERE'S NO `<Route>` COMPONENT:
//
//   We chose data-style routes — definitions live in
//   `createRouter({ routes: [...] })`, NOT in the rendered tree.
//   So there's nothing for a `<Route>` element to *do*; the
//   `routes` array IS the configuration. `<Routes>` is the only
//   DOM-side dispatcher we need.
//
// CHAIN WRAPPING:
//
//   For a match like `[UsersLayout, UserProfile]` with params
//   `{ id: '42' }`, the rendered output is:
//
//     UsersLayout({ children: UserProfile({}) })
//
//   We walk the matched chain right to left (leaf → root),
//   building up the `children` argument for each layout. Params
//   are NOT passed as props — components read them via
//   `useParams(router)`. That keeps the route-component contract
//   (just `{ children? }`) tiny and uniform.
//
// SWAP PATTERN:
//
//   Same as `<Show>` / `<Switch>` / `<Dynamic>`: invisible
//   `display: contents` placeholder, one branch alive at a time,
//   each branch owned by its own `createRoot` so its effects and
//   components are disposed on swap. Covered by leak-regression
//   tests in the renderer suite — we follow the proven shape.
//
// REACTIVITY:
//
//   `router.match` is a memo with structural equality on
//   route+params — so this effect only re-runs when the match
//   actually changes, not on every URL update. Cosmetic changes
//   (same path, different hash) leave the rendered tree
//   completely untouched.
//
// ============================================================================

import type { DisposeFn } from '@azerothjs/reactivity';
import { createEffect, createRoot } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import type { RouteMatch } from './types.ts';
import type { Router } from './router.ts';

/**
 * Props for the `<Routes>` component.
 */
export interface RoutesProps
{
    /** The router whose `match()` drives this dispatcher. */
    router: Router;

    /**
     * Optional fallback component, rendered when no route matches.
     * Use it for 404 / catch-all UI. If absent, nothing is
     * rendered for unmatched URLs.
     */
    fallback?: () => HTMLElement;
}

/**
 * Renders the currently matched route chain into the DOM,
 * automatically swapping content when the route changes.
 *
 * Place exactly one `<Routes>` somewhere in your component tree
 * — typically inside the top-level layout. The component
 * subscribes to `router.match()` and re-renders only when the
 * match actually changes (route reference or params), so cosmetic
 * URL updates (hash, query, search) leave the tree intact.
 *
 * @param props - `{ router, fallback? }`
 *
 * @returns An invisible (`display: contents`) container that
 *          holds the currently rendered route chain.
 *
 * @example
 * ```ts
 * const App = defineComponent(() =>
 * {
 *     const router = createRouter({
 *         routes:
 *         [
 *             { path: '/', component: Home },
 *             { path: '/users/:id', component: UserPage }
 *         ]
 *     });
 *
 *     return h('div', { class: 'app' },
 *         h('nav', {},
 *             Link({ to: '/', router, children: 'Home' }),
 *             Link({ to: '/users/42', router, children: 'User 42' })
 *         ),
 *         Routes({ router, fallback: () => h('h1', {}, '404') })
 *     );
 * });
 * ```
 */
export function Routes(props: RoutesProps): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    let branchDispose: DisposeFn | null = null;

    createEffect(() =>
    {
        // Tear the previous branch down before drawing the next
        // one. This disposes any effects and runs `onDestroy`
        // hooks for the old route's components.
        teardownBranch();

        const matchResult = props.router.match();

        const factory = matchResult !== null
            ? (): HTMLElement => renderChain(matchResult)
            : props.fallback;

        if (!factory) return;

        // Each branch owns its own root so the effect lifetimes
        // for the rendered components are scoped to this match.
        createRoot((dispose) =>
        {
            branchDispose = dispose;
            container.appendChild(factory());
        });

        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

        // Remove children one by one so MutationObserver-based
        // primitives (Portal) can detect the removal, and run the
        // component destroy hooks on each element on the way out.
        while (container.firstChild)
        {
            const node = container.firstChild;
            container.removeChild(node);
            if (node instanceof HTMLElement)
            {
                destroyComponent(node);
            }
        }
    }

    return container as unknown as HTMLElement;
}

/**
 * Walks the matched root → leaf chain and produces a single
 * rendered tree by wrapping each level inside the level above
 * it.
 *
 *   matched: [A, B, C]
 *   result : A({ children: B({ children: C({}) }) })
 *
 * Layouts (intermediate nodes) MUST place their `children` prop
 * somewhere in their returned tree — typically inside an
 * `<Outlet>`. Without that placement, deeper levels won't be
 * visible. (`<Outlet>` is just sugar for `props.children`.)
 *
 * @internal
 */
function renderChain(matchResult: RouteMatch): HTMLElement
{
    const chain = matchResult.matched;
    let current: HTMLElement | undefined = undefined;

    for (let i = chain.length - 1; i >= 0; i--)
    {
        const route = chain[i];
        current = route.component({ children: current });
    }

    // chain.length is always >= 1 for a non-null RouteMatch — the
    // matched route IS the chain — so `current` is guaranteed to
    // be assigned. The non-null assertion encodes that invariant.
    return current!;
}
