/**
 * The bridge between a Router and the DOM: read the match reactively, render the matched
 * chain with layouts wrapping leaves, and swap cleanly when the match changes. There is no
 * `<Route>` component, because routes are data passed to createRouter, so this is the only
 * DOM-side dispatcher needed.
 *
 * A match of `[UsersLayout, UserProfile]` renders as
 * `UsersLayout({ children: UserProfile({}) })`: the chain is walked leaf to root, and each
 * layout places its `children`, typically through an `<Outlet>`. Params are NOT props -
 * components read them with useParams - which keeps the route-component contract down to
 * `{ children? }`.
 *
 * The swap is the same comment-marker range Show, Switch and Dynamic use, with one branch
 * alive at a time and each branch in its own root, so effects and destroy hooks fire on swap.
 * Since the match is a structural-equality memo, the effect re-runs only when the route or
 * its params genuinely change, not for a cosmetic URL update carrying the same path with a
 * different hash or query.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createRoot, isStringMode, isHydrating, onRootDispose, untrack } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode, deferHydration, runInPass } from '../reactivity/internal.ts';
import type { HydrationPass } from '../reactivity/internal.ts';
import { type CoTarget, type MountNode, createCoMarkers, appendToCo, clearCo, adoptCoRange, resolveMountNode } from '../component/index.ts';
import { playTransitionClasses } from '../renderer/transition-classes.ts';
import { adoptStyleSheet } from '../renderer/adopt-style.ts';
import { hydrateChild } from '../renderer/h.ts';
import type { RouteMatch } from './types.ts';
import type { NavigationKind, Router } from './router.ts';
import { componentOf } from './router.ts';
import { withRouteLevel, resolveRouter } from './provider.ts';

/** What a `transition` FUNCTION receives to pick (or veto) a name per swap. */
export interface RouteTransitionContext
{
    /** The match being left, or null when the fallback was showing. */
    from: RouteMatch | null;

    /** The match being entered, or null when swapping to the fallback. */
    to: RouteMatch | null;

    /** What caused the change - 'push' | 'replace' | 'pop'; the directional-drift hook. */
    navigation: NavigationKind;

    /** Pop distance (-1 back, +1 forward, 0 otherwise) - the finer directional hook. */
    delta: number;

    /** The target entry's stamp. */
    key: string;
}

/**
 * Props for the `<Routes>` component.
 */
export interface RoutesProps
{
    /** The router whose `match()` drives this dispatcher; omit inside a <RouterProvider>. */
    router?: Router;

    /**
     * Optional fallback component, rendered when no route matches. Use it for
     * 404 / catch-all UI. If absent, nothing is rendered for unmatched URLs.
     */
    fallback?: (() => MountNode) | undefined;

    /**
     * Animate route swaps with `<Transition>`'s 6-class family: the outgoing
     * route plays `{name}-leave-*` (removal deferred until it completes) while
     * the incoming plays `{name}-enter-*` - both mounted simultaneously, so a
     * cross-fade or a directional drift is pure CSS. A FUNCTION receives
     * {@link RouteTransitionContext} (from, to, and what caused the change) and
     * returns the name per swap - or null for an instant swap - which is how a
     * back-navigation gets a different animation than a forward one.
     *
     * Requires the route chain to render a SINGLE ELEMENT root; a fragment root
     * swaps instantly (classes need one element to land on). The first render
     * never animates.
     */
    transition?: string | ((context: RouteTransitionContext) => string | null) | undefined;

    /** Fallback timeout (ms) for the transition waits; default 1000. */
    transitionDuration?: number | undefined;
}

/**
 * Renders the router's currently matched route chain, swapping content and disposing the
 * previous branch when the match changes.
 *
 * A layout route MUST place its `children`, normally through an {@link Outlet}, or the deeper
 * levels never appear. Params reach components through useParams, never as props.
 *
 * Place it once per dispatch point, typically inside the top-level layout. Several Routes for
 * the same router are legal but mean several independent dispatch points.
 *
 * The effect re-runs only when the route or its params change, so a hash- or query-only URL
 * change leaves the rendered tree completely intact. Each branch builds in its own root and
 * is disposed on swap, and the build is read under untrack, so a route component's own signal
 * reads never rebuild the whole branch.
 *
 * @param props - See {@link RoutesProps}. `fallback` renders when nothing matches; without
 *                one, nothing renders.
 * @returns A handle holding the rendered chain.
 * @example
 * Routes({ router, fallback: () => h('h1', {}, '404') });
 *
 * @see {@link createRouter}
 * @see {@link Outlet}
 */
export function Routes(props: RoutesProps): MountNode
{
    const router = resolveRouter(props.router, 'Routes');
    // Server-side rendering: evaluate the match ONCE (no live effect) and emit the
    // matched chain (or fallback) inside a contents anchor the client hydrator can
    // adopt - the same pattern as <Show>/<Switch>. (On the client, hydration currently
    // re-renders the matched chain rather than adopting it in place.)
    if (isStringMode())
    {
        const matchResult = untrack(() => router.match());
        const inner = matchResult !== null
            ? serializeChild(renderChain(matchResult, router))
            : (props.fallback ? serializeChild(props.fallback()) : '');
        return wrapContentsAnchored('routes', inner) as unknown as MountNode;
    }

    // Hydration: adopt the server-rendered range and its current route on the
    // first effect run; later navigations use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveRoutes(props, router, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: comment markers bracket the active route (no wrapper
    // element), so <Routes> works directly inside <table>/<select>/<ul>.
    const { fragment, target } = createCoMarkers('routes');
    driveRoutes(props, router, target, false);
    return fragment;
}

/**
 * Wires the match-selection effect onto `target`. Shared by the DOM path (a
 * marker range) and hydration (the adopted server range). Renders the matched
 * route chain (or fallback) into its own root so the leaving route's effects and
 * `onDestroy` hooks run on every swap.
 *
 * @internal
 */
function driveRoutes(props: RoutesProps, router: Router, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;
    let mounted = false;

    // Held while this <Routes> still owes the hydration pass an adoption. Taken when the
    // first run cannot proceed (an unresolved lazy chunk) and released the moment the range
    // is adopted or abandoned. It carries the pass itself because the adopting re-run is
    // scheduled by the reactive system, long after hydrate()'s synchronous window closed:
    // without re-entering the pass that run would build fresh DOM over the server's markup
    // and leave the page inert.
    let deferred: { pass: HydrationPass; release: () => void } | null = null;

    // The current branch's SINGLE root element, when it has one - the thing a
    // transition's classes can land on. null for fragment-rooted branches.
    let currentEl: HTMLElement | null = null;
    let previousMatch: RouteMatch | null = null;

    // Outgoing branches still playing their leave: kept in the DOM (and their
    // roots alive) until the animation settles or the next swap flushes them.
    const leaving = new Map<HTMLElement, { dispose: DisposeFn; cancel: () => void }>();

    /** Finishes every still-leaving branch NOW - rapid navigation stays crisp. */
    function flushLeaving(): void
    {
        for (const [el, entry] of [...leaving])
        {
            entry.cancel();
            leaving.delete(el);
            el.parentNode?.removeChild(el);
            entry.dispose();
        }
    }

    /** The name for this swap, from the string or function form; null = instant. */
    function transitionName(to: RouteMatch | null): string | null
    {
        const transition = props.transition;
        if (transition === undefined)
        {
            return null;
        }
        if (typeof transition === 'string')
        {
            return transition;
        }
        const l = router.location();
        return transition({ from: previousMatch, to, navigation: l.navigationKind, delta: l.delta, key: l.key });
    }

    createEffect(() =>
    {
        const matchResult = router.match();

        // A chain containing an unresolved lazy chunk is not renderable yet: keep
        // the CURRENT screen (previous route, or nothing on a cold start - never a
        // flash of a half-loaded chain) and return. chainReady is reactive and read
        // unconditionally here, so the effect re-runs the moment the chunk lands; a
        // FAILED chunk counts as ready and componentOf throws its load error into
        // the branch, where an <ErrorBoundary> catches it.
        if (matchResult !== null && !router.chainReady())
        {
            // Adoption is owed but cannot happen yet: keep the pass open across the wait so
            // the re-run that lands the chunk still adopts instead of rebuilding.
            if (firstRun && deferred === null)
            {
                deferred = deferHydration();
            }
            return;
        }

        const factory: (() => MountNode) | null = matchResult !== null
            ? (): MountNode => renderChain(matchResult, router)
            : (props.fallback ?? null);

        if (firstRun)
        {
            // Hydration first run: adopt the existing server children rather than
            // building and appending new ones.
            firstRun = false;
            mounted = true;
            previousMatch = matchResult;

            /** Claims the server range for the matched chain. Runs under the pass. */
            const adopt = (): void =>
            {
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
            };

            const resume = deferred;
            try
            {
                // Straight through on the synchronous first run (already inside the pass);
                // through runInPass when the chunk made us wait, which both restores
                // 'hydrate' and routes a mismatch to hydrate()'s fallback instead of letting
                // it escape as an unhandled rejection.
                if (resume !== null)
                {
                    runInPass(resume.pass, adopt);
                }
                else
                {
                    adopt();
                }
            }
            finally
            {
                // Adopted, or failed trying - either way this <Routes> owes the pass nothing more.
                resume?.release();
                deferred = null;
            }
            return;
        }

        // The name only applies when there is an OUTGOING single-element branch
        // to animate; the very first render mounts instantly.
        const wasMounted = mounted;
        const name = mounted ? untrack(() => transitionName(matchResult)) : null;
        const animated = name !== null && currentEl !== null;
        previousMatch = matchResult;
        mounted = true;

        // A new navigation arriving mid-animation finishes the old exits NOW.
        flushLeaving();

        if (animated)
        {
            // Detach the outgoing branch WITHOUT removing it: it stays in place
            // playing its leave while the incoming mounts alongside.
            const el = currentEl as HTMLElement;
            const dispose = branchDispose;
            branchDispose = null;
            currentEl = null;
            const entry = {
                dispose: dispose ?? ((): void => undefined),
                cancel: (): void => undefined
            };
            leaving.set(el, entry);
            entry.cancel = playTransitionClasses(el, name, 'leave', props.transitionDuration, () =>
            {
                leaving.delete(el);
                el.parentNode?.removeChild(el);
                entry.dispose();
            });
        }
        else
        {
            teardownBranch();
        }

        // Only a real NAVIGATION swap moves focus - the initial mount must not
        // steal focus from wherever the user (or the browser) put it.
        const moveFocus = wasMounted && router.focusManagement;

        if (factory)
        {
            // Each branch owns its own root so its effects dispose on swap.
            // untrack: only `match()` drives this effect - a signal read inside a
            // route component must not subscribe (and rebuild) the whole branch.
            const build = factory;
            createRoot((dispose) =>
            {
                branchDispose = dispose;
                // resolveMountNode per the co-range caller contract: a fallback/factory result
                // may be a thunk that must be invoked before it can be appended as a node.
                const built = resolveMountNode(untrack(build)) ?? null;
                appendToCo(target, built);
                currentEl = built instanceof HTMLElement ? built : null;
                if (name !== null && currentEl !== null)
                {
                    playTransitionClasses(currentEl, name, 'enter', props.transitionDuration, () => undefined);
                }
                if (moveFocus && currentEl !== null)
                {
                    focusRouteContent(currentEl);
                }
            });
        }
        else
        {
            currentEl = null;
        }
    });

    // Final teardown: the active branch AND any branches still mid-leave.
    onRootDispose(() =>
    {
        flushLeaving();
        teardownBranch();
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }
        if (currentEl !== null)
        {
            currentEl.parentNode?.removeChild(currentEl);
            currentEl = null;
            return;
        }
        clearCo(target);
    }
}

/**
 * Moves focus into freshly swapped route content (an element marked
 * `data-route-focus` wins; the content root otherwise), so keyboard and
 * screen-reader users land where the navigation took them. A transient
 * `tabindex="-1"` makes a non-focusable root focusable for exactly this
 * programmatic move and cleans itself up on blur; `preventScroll` keeps the
 * router's own scroll management authoritative.
 *
 * When focusing the FALLBACK region (the app did not mark a `[data-route-focus]`
 * target), the region is tagged with `data-azeroth-route-focus-fallback` for the
 * duration of the programmatic focus and a single, overridable stylesheet hides the
 * default focus ring for that attribute: this is a focus-for-assistive-tech on a whole
 * page region, not a user-driven control focus, so a visible outline around it reads as a
 * stray page/window border. The framework never mutates the element's inline styles -
 * presentation stays declarative and app-overridable - and an app that opts in with
 * `[data-route-focus]` keeps its outline fully stylable.
 *
 * @internal
 */
function focusRouteContent(root: HTMLElement): void
{
    const marked = root.querySelector<HTMLElement>('[data-route-focus]');
    const target = marked ?? root;
    if (!target.hasAttribute('tabindex'))
    {
        target.setAttribute('tabindex', '-1');
        // Only the router's own fallback region is tagged; a marked target is the app's to style.
        const tagged = marked === null;
        if (tagged)
        {
            ensureRouteFocusStyle();
            target.setAttribute(ROUTE_FOCUS_FALLBACK_ATTR, '');
        }
        target.addEventListener('blur', () =>
        {
            target.removeAttribute('tabindex');
            target.removeAttribute(ROUTE_FOCUS_FALLBACK_ATTR);
        }, { once: true });
    }
    target.focus({ preventScroll: true });
}

const ROUTE_FOCUS_FALLBACK_ATTR = 'data-azeroth-route-focus-fallback';

/**
 * Injects, once per document, the single overridable rule that hides the default focus ring on
 * the router's transient programmatic route-focus region. Author-level (no `!important`) so an
 * app can override it; scoped to the framework-owned attribute so it touches nothing else.
 *
 * @internal
 */
function ensureRouteFocusStyle(): void
{
    adoptStyleSheet(
        ROUTE_FOCUS_FALLBACK_ATTR,
        `[${ ROUTE_FOCUS_FALLBACK_ATTR }]{outline:none}`,
        ROUTE_FOCUS_FALLBACK_ATTR
    );
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
 * Each level's component is CONSTRUCTED inside `withRouteLevel(router, i)`, so a
 * `useLoader()`/`useSearch()` call in its body resolves this level (and this
 * router) without any argument. Components resolve through `componentOf` - the
 * direct component or the resolved lazy chunk (whose load error throws here,
 * into the branch an `<ErrorBoundary>` wraps).
 *
 * @internal
 */
function renderChain(matchResult: RouteMatch, router: Router): MountNode
{
    const chain = matchResult.matched;
    let current: MountNode | undefined = undefined;

    for (let i = chain.length - 1; i >= 0; i--)
    {
        const route = chain[i];
        if (route === undefined)
        {
            continue; // matched chains are dense; satisfies the indexed-access check
        }
        const level = i;
        const previous: MountNode | undefined = current;
        current = withRouteLevel(router, level, () => componentOf(route)({ children: previous }));
    }

    if (current === undefined)
    {
        // chain.length is always >= 1 for a non-null RouteMatch (the matched route
        // IS the chain) - an empty chain means the match table is corrupted.
        throw new Error('renderChain: RouteMatch carried an empty matched chain.');
    }
    return current;
}
