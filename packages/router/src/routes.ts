/**
 * MODULE: router/routes
 *
 * <Routes> is the bridge between a Router and the DOM: it reads router.match() reactively, renders
 * the matched route chain (layouts wrapping leaves), and swaps content cleanly when the match
 * changes. There is no <Route> component - routes are data, defined in createRouter({ routes }),
 * so <Routes> is the only DOM-side dispatcher needed.
 *
 * CHAIN WRAPPING: a match [UsersLayout, UserProfile] renders as
 * UsersLayout({ children: UserProfile({}) }) - the chain is walked leaf-to-root, each layout
 * placing its `children` (typically via <Outlet>). Params are NOT props; components read them via
 * useParams(router), keeping the route-component contract ({ children? }) tiny and uniform.
 *
 * SWAP PATTERN: the same co-range one as <Show>/<Switch>/<Dynamic> - comment-marker range, one
 * branch alive at a time, each branch in its own createRoot so effects/onDestroy fire on swap.
 * Because router.match is a structural-equality memo, the effect re-runs only when the match truly
 * changes (route or params), not on cosmetic URL updates (same path, different hash/query).
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { type CoTarget, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '@azerothjs/component';
import { hydrateChild } from '@azerothjs/renderer';
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
     * Optional fallback component, rendered when no route matches. Use it for
     * 404 / catch-all UI. If absent, nothing is rendered for unmatched URLs.
     */
    fallback?: () => HTMLElement;
}

/**
 * Routes
 *
 * PURPOSE:
 * Renders the router's currently-matched route chain into the DOM, automatically swapping content
 * (and disposing the previous branch) when the match changes.
 *
 * WHY IT EXISTS:
 * A hand-rolled match effect can swap the matched component but leaks the old branch's effects and
 * does not wrap nested layouts. Routes reads match() reactively, wraps the full layout chain, and
 * tears the previous branch down on every swap - the routing-aware counterpart of a control-flow swap.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; a control-flow dispatcher built on the co-range. Mode-dispatched: SSR emits the
 * matched chain once, hydration adopts the server range on the first effect run, the client swaps.
 *
 * INPUT CONTRACT:
 * - router: the Router whose match() drives the dispatch.
 * - fallback: optional thunk rendered when no route matches (404/catch-all); nothing if absent.
 *
 * OUTPUT CONTRACT:
 * - A co-range handle holding the currently rendered route chain, swapping reactively on match change.
 *
 * WHY THIS DESIGN:
 * router.match's structural equality means the effect re-runs only when route or params change, not
 * on cosmetic URL updates. Each branch builds in its own createRoot (disposed on swap); renderChain
 * wraps the matched chain leaf-to-root so layouts nest; the build is read under untrack so a route
 * component's signal reads do not rebuild the whole branch.
 *
 * WHEN TO USE:
 * Exactly once in the tree (typically inside the top-level layout) to render the active route.
 *
 * WHEN NOT TO USE:
 * For non-route conditional content (use {@link Show}). Do not place multiple <Routes> for the same
 * router unless you intend independent dispatch points.
 *
 * EDGE CASES:
 * - No match and no fallback renders nothing.
 * - Cosmetic URL changes (hash/query only) leave the rendered tree intact.
 *
 * PERFORMANCE NOTES:
 * Re-renders only when the match changes, not on every URL update; one branch alive at a time.
 *
 * DEVELOPER WARNING:
 * A layout route MUST place its `children` (via {@link Outlet}) or deeper levels will not appear.
 * Params reach components through useParams(router), not as props.
 *
 * @param props - {@link RoutesProps}: `router`, optional `fallback`.
 * @returns A co-range handle holding the rendered route chain.
 * @see {@link createRouter}
 * @see {@link Outlet}
 * @example
 * Routes({ router, fallback: () => h('h1', {}, '404') });
 */
export function Routes(props: RoutesProps): HTMLElement
{
    // Server-side rendering: evaluate the match ONCE (no live effect) and emit the
    // matched chain (or fallback) inside a contents anchor the client hydrator can
    // adopt - the same pattern as <Show>/<Switch>. (Hydration adoption itself is a
    // later milestone; on the client this currently re-renders.)
    if (isStringMode())
    {
        const matchResult = untrack(() => props.router.match());
        const inner = matchResult !== null
            ? serializeChild(renderChain(matchResult))
            : (props.fallback ? serializeChild(props.fallback()) : '');
        return wrapContentsAnchored('routes', inner) as unknown as HTMLElement;
    }

    // Hydration: adopt the server-rendered range and its current route on the
    // first effect run; later navigations use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveRoutes(props, target, true, contentCursor);
        }) as unknown as HTMLElement;
    }

    // Fresh client render: comment markers bracket the active route (no wrapper
    // element), so <Routes> works directly inside <table>/<select>/<ul>.
    const { fragment, target } = createCoMarkers('routes');
    driveRoutes(props, target, false);
    return fragment as unknown as HTMLElement;
}

/**
 * Wires the match-selection effect onto `target`. Shared by the DOM path (a
 * marker range) and hydration (the adopted server range). Renders the matched
 * route chain (or fallback) into its own root so the leaving route's effects and
 * `onDestroy` hooks run on every swap.
 *
 * @internal
 */
function driveRoutes(props: RoutesProps, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    createEffect(() =>
    {
        const matchResult = props.router.match();
        const factory: (() => HTMLElement) | null = matchResult !== null
            ? (): HTMLElement => renderChain(matchResult)
            : (props.fallback ?? null);

        if (firstRun)
        {
            // Hydration first run: adopt the existing server children rather than
            // building and appending new ones.
            firstRun = false;
            if (factory)
            {
                const build = factory;
                createRoot((dispose) =>
                {
                    branchDispose = dispose;
                    hydrateChild(untrack(build), hydrationCursor as HydrationCursorType);
                });
            }

            // Every server node in this range must be claimed by the adopted
            // route chain; a leftover means SSR/CSR diverged. hydrate() recovers.
            hydrationCursor?.assertExhausted('<Routes> content');
            return teardownBranch;
        }

        if (factory)
        {
            // Each branch owns its own root so its effects dispose on swap.
            // untrack: only `match()` drives this effect - a signal read inside a
            // route component must not subscribe (and rebuild) the whole branch.
            const build = factory;
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                appendToCo(target, untrack(build));
            });
        }

        // The SINGLE teardown path: runs before every re-render AND on dispose, so
        // the leaving route's effects + onDestroy hooks fire before its DOM goes.
        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }
        clearCo(target);
    }
}

/**
 * Walks the matched root-to-leaf chain and produces a single rendered tree by
 * wrapping each level inside the level above it.
 *
 *   matched: [A, B, C]
 *   result : A({ children: B({ children: C({}) }) })
 *
 * Layouts (intermediate nodes) must place their `children` prop somewhere in
 * their returned tree, typically inside an `<Outlet>`. Without that placement,
 * deeper levels won't be visible. (`<Outlet>` is just sugar for
 * `props.children`.)
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

    // chain.length is always >= 1 for a non-null RouteMatch (the matched route
    // is the chain), so `current` is guaranteed to be assigned. The non-null
    // assertion encodes that invariant.
    return current!;
}
