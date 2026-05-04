// ============================================================================
// AZEROTHJS — Core Router
// ============================================================================
//
// `createRouter` is the orchestrator. Every other router export
// (Link, Route, Outlet, useRoute, useParams, useQuery) is a thin
// reactive layer on top of what the Router object exposes.
//
// FLOW:
//
//   ┌──────────────┐    push/replace    ┌────────────────┐
//   │   navigate() ├───────────────────►│ HistoryAdapter │
//   └──────────────┘                    └───────┬────────┘
//                                               │ subscribe
//                                               ▼
//                                       ┌────────────────┐
//                                       │ state signal   │
//                                       └─────┬─────┬────┘
//                                             │     │
//                                  ┌──────────▼─┐  ┌▼──────────┐
//                                  │  location  │  │   match   │
//                                  │   memo     │  │   memo    │
//                                  └────────────┘  └───────────┘
//
// LIFECYCLE:
//
//   The history subscription is registered with the surrounding
//   `createRoot` via `onRootDispose`. When the root unmounts, the
//   subscription is dropped — and if it was the last subscriber on
//   the underlying adapter, the native popstate listener is also
//   removed (see history.ts).
//
//   This means createRouter MUST be called inside a createRoot()
//   for cleanup to work. In an AzerothJS app the top-level
//   render() already wraps the tree in a root, so the typical
//   `render(() => RootComponent({}), document.body)` pattern is
//   covered. When using createRouter standalone (in tests, in
//   isolated components), wrap the call yourself:
//
//     createRoot((dispose) =>
//     {
//         const router = createRouter({ routes: [...] });
//         // …use router…
//         dispose(); // tears down the popstate subscription
//     });
//
// MATCHING STRATEGY:
//
//   At construction time we walk the (possibly nested) route tree
//   and produce one entry per leaf, where each entry holds:
//     - the compiled full-path matcher
//     - the root → leaf chain (so <Outlet> can walk it)
//
//   Matching is then a simple linear scan over leaves, returning
//   the FIRST hit. Ordering of routes in the input config defines
//   priority — that's deliberate, predictable, and matches every
//   other router on the web.
//
// ============================================================================

import type { Getter } from '@azerothjs/reactivity';
import { createSignal, createMemo, onRootDispose, untrack } from '@azerothjs/reactivity';
import type {
    HistoryAdapter,
    NavigateOptions,
    NavigateTarget,
    Params,
    Route,
    RouteLocation,
    RouteMatch,
    RouterConfig
} from './types.ts';
import { compilePath, type PathMatcher } from './path-pattern.ts';
import { parseQuery, stringifyQuery } from './query.ts';
import { createBrowserHistory } from './history.ts';

/**
 * The object returned by `createRouter()`.
 *
 * Holds the reactive location/match signals and exposes
 * imperative navigation methods. Pass it to `<Link>`, `<Route>`,
 * `<Outlet>`, or to the `useRoute`/`useParams`/`useQuery`
 * composables.
 */
export interface Router
{
    /**
     * Reactive snapshot of the current location.
     *
     * Updates whenever the URL changes — programmatically or via
     * the browser's back/forward buttons.
     */
    location: Getter<RouteLocation>;

    /**
     * The currently matched route, or `null` if no route matches.
     *
     * Walked by `<Outlet>` for nested layouts. Composable: a
     * memo with structural equality, so cosmetic location changes
     * (e.g. only the hash) don't invalidate it.
     */
    match: Getter<RouteMatch | null>;

    /**
     * Navigates to `to`, pushing a new history entry.
     *
     * `to` may be a `fullPath` string or a structured object;
     * `options` accept `replace`, `state`, and `scroll`.
     *
     * @example
     * ```ts
     * router.navigate('/users/42');
     * router.navigate({ pathname: '/search', query: { q: 'azeroth' } });
     * router.navigate('/login', { replace: true, scroll: true });
     * ```
     */
    navigate(to: NavigateTarget, options?: NavigateOptions): void;

    /**
     * Replaces the current history entry with `to`.
     *
     * Equivalent to `navigate(to, { replace: true })` but cannot
     * be inverted by setting `replace: false`. Useful for redirects
     * where you don't want the original URL on the back stack.
     */
    replace(to: NavigateTarget, options?: Omit<NavigateOptions, 'replace'>): void;

    /** Steps back one history entry — same as the browser's Back button. */
    back(): void;

    /** Steps forward one history entry — same as the browser's Forward button. */
    forward(): void;
}

/**
 * Internal flat-list entry produced from the (possibly nested)
 * input route tree. One entry per leaf.
 *
 * @internal
 */
interface LeafEntry
{
    matcher: PathMatcher;
    /** Root → leaf chain — used by `<Outlet>`. */
    matched: Route[];
}

/**
 * Joins a parent path and a child path into a full path.
 *
 * Handles the common edge cases so the user can write either
 * leading-slash or naked child paths and get a sane result.
 *
 *   joinPaths('/',  ''       ) → '/'
 *   joinPaths('/',  'about'  ) → '/about'
 *   joinPaths('/users', ''   ) → '/users'
 *   joinPaths('/users', ':id') → '/users/:id'
 *   joinPaths('/users/', ':id') → '/users/:id'
 *
 * @internal
 */
function joinPaths(parent: string, child: string): string
{
    let p = parent;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    let c = child;
    if (c.startsWith('/')) c = c.slice(1);

    if (c === '') return p === '' ? '/' : p;
    if (p === '' || p === '/') return '/' + c;
    return p + '/' + c;
}

/**
 * Walks the (possibly nested) route tree and emits one entry
 * per leaf, where each entry's matcher is built from the joined
 * parent paths and the `matched` array is the root-to-leaf chain.
 *
 * Internal nodes (routes that have children) become layouts —
 * they're never matched on their own; they only appear inside
 * the `matched` chain of one of their descendants.
 *
 * @internal
 */
function flattenRoutes(
    routes: Route[],
    parentPath = '',
    parentChain: Route[] = []
): LeafEntry[]
{
    const out: LeafEntry[] = [];

    for (const route of routes)
    {
        const fullPath = joinPaths(parentPath, route.path);
        const chain = [...parentChain, route];

        if (route.children && route.children.length > 0)
        {
            out.push(...flattenRoutes(route.children, fullPath, chain));
        }
        else
        {
            out.push({ matcher: compilePath(fullPath), matched: chain });
        }
    }

    return out;
}

/**
 * Splits a full URL fragment into its three components.
 *
 * `fullPath` is treated as `pathname[?search][#hash]`. Any of
 * the three may be empty. We don't use the URL constructor
 * because it requires a base — and we don't want to invent one.
 *
 * @internal
 */
function splitFullPath(fullPath: string): { pathname: string; search: string; hash: string }
{
    const hashIdx = fullPath.indexOf('#');
    const hash = hashIdx >= 0 ? fullPath.slice(hashIdx) : '';
    const beforeHash = hashIdx >= 0 ? fullPath.slice(0, hashIdx) : fullPath;

    const searchIdx = beforeHash.indexOf('?');
    const search = searchIdx >= 0 ? beforeHash.slice(searchIdx) : '';
    const pathname = searchIdx >= 0 ? beforeHash.slice(0, searchIdx) : beforeHash;

    return { pathname, search, hash };
}

/**
 * Converts a `NavigateTarget` (string or structured) into a
 * canonical `fullPath` string.
 *
 * Adds the leading `?` to a built search and the leading `#` to
 * a hash if the caller forgot. We never strip these — they're
 * part of the path's shape and stripping them would silently
 * change semantics.
 *
 * Exported so `<Link>` can render the same string into the `href`
 * attribute that `navigate()` would push to history. Both code
 * paths produce the same canonical form.
 */
export function targetToFullPath(target: NavigateTarget): string
{
    if (typeof target === 'string') return target;

    const search = target.query ? stringifyQuery(target.query) : '';
    const searchPart = search.length > 0 ? '?' + search : '';

    let hashPart = '';
    if (target.hash && target.hash.length > 0)
    {
        hashPart = target.hash.startsWith('#') ? target.hash : '#' + target.hash;
    }

    return target.pathname + searchPart + hashPart;
}

/**
 * Internal state that the location and match memos derive from.
 *
 * Bundling these into one signal means we match the URL exactly
 * once per change (in the history listener) — the memos that
 * read it are then near-free structural reads.
 *
 * @internal
 */
interface InternalState
{
    fullPath: string;
    pathname: string;
    search: string;
    hash: string;
    /** Cached match result — used by both the `location.params` and the `match` memo. */
    matched: RouteMatch | null;
}

/**
 * Creates a `Router` for the given config.
 *
 * Must be called inside a `createRoot()` so the underlying
 * history subscription can be cleaned up on unmount. AzerothJS's
 * `render()` wraps the tree in a root automatically, so calling
 * `createRouter` from inside a top-level component is fine.
 *
 * @param config - Routes, optional base path, optional mode.
 *                 `mode` is currently always `'history'`; the
 *                 field exists so future modes (`'hash'`,
 *                 `'memory'`) can be added without breaking.
 *
 * @returns A `Router` ready to drive `<Link>`, `<Route>`,
 *          `<Outlet>`, and the route composables.
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
 *     return h('div', {},
 *         Link({ to: '/', router, children: 'Home' }),
 *         Link({ to: '/users/42', router, children: 'User 42' }),
 *         Routes({ router })
 *     );
 * });
 * ```
 */
export function createRouter(config: RouterConfig): Router
{
    // ── Setup ────────────────────────────────────────────────
    const leaves = flattenRoutes(config.routes);
    const history: HistoryAdapter = createBrowserHistory();

    function matchPathname(pathname: string): RouteMatch | null
    {
        for (const entry of leaves)
        {
            const result = entry.matcher.match(pathname);
            if (result === null) continue;

            return {
                route: entry.matched[entry.matched.length - 1],
                params: result.params,
                matched: entry.matched,
                pathname
            };
        }
        return null;
    }

    function buildState(fullPath: string): InternalState
    {
        const { pathname, search, hash } = splitFullPath(fullPath);
        return {
            fullPath,
            pathname,
            search,
            hash,
            matched: matchPathname(pathname)
        };
    }

    // Initial state — read straight from the live URL.
    const [state, setState] = createSignal<InternalState>(buildState(history.current()));

    // ── React to URL changes ─────────────────────────────────
    const unsubHistory = history.subscribe((fullPath) =>
    {
        setState(buildState(fullPath));
    });

    // Cleanup when the surrounding root tears down. If this call
    // happens outside a root, the disposer is silently dropped
    // (see onRootDispose docs) — the popstate listener will leak.
    // The JSDoc on createRouter spells out the requirement.
    onRootDispose(unsubHistory);

    // ── Derived signals ──────────────────────────────────────

    /** A user-facing snapshot. Re-derives only when state changes. */
    const location = createMemo<RouteLocation>(() =>
    {
        const s = state();
        return {
            pathname: s.pathname,
            search: s.search,
            hash: s.hash,
            params: s.matched?.params ?? {},
            query: parseQuery(s.search),
            fullPath: s.fullPath
        };
    });

    /**
     * The matched route, with structural equality so cosmetic
     * URL changes (e.g. only the hash) don't invalidate
     * downstream effects that watch the matched route.
     */
    const match = createMemo<RouteMatch | null>(
        () => state().matched,
        {
            equals: (a, b) =>
            {
                // The memo's underlying signal starts with `undefined`
                // before the compute fn runs the first time, so
                // equals will be invoked as `equals(undefined, …)`
                // on the very first set. Use `==` here to catch both
                // null and undefined in one branch.
                if (a === b) return true;
                if (a == null || b == null) return false;
                if (a.route !== b.route) return false;
                return shallowEqualParams(a.params, b.params);
            }
        }
    );

    // ── Navigation ───────────────────────────────────────────

    function performNavigate(target: NavigateTarget, options: NavigateOptions): void
    {
        const fullPath = targetToFullPath(target);

        if (options.replace)
        {
            history.replace(fullPath, options.state);
        }
        else
        {
            history.push(fullPath, options.state);
        }

        // Optional opt-in scroll to top — the router doesn't
        // restore scroll automatically. Users who need bespoke
        // scroll behavior can subscribe to `location` instead.
        if (options.scroll)
        {
            window.scrollTo({ top: 0, left: 0 });
        }
    }

    return {
        location,
        match,
        navigate(to, options = {}): void
        {
            // untrack so navigate can be called from inside an
            // effect without that effect subscribing to whatever
            // signals the user might evaluate while building `to`.
            untrack(() => performNavigate(to, options));
        },
        replace(to, options = {}): void
        {
            untrack(() => performNavigate(to, { ...options, replace: true }));
        },
        back(): void
        {
            history.back();
        },
        forward(): void
        {
            history.forward();
        }
    };
}

/**
 * Compares two `Params` records by key+value. Used by the match
 * memo's custom equality so re-renders are skipped when a
 * navigation produces the same route + same params.
 *
 * @internal
 */
function shallowEqualParams(a: Params, b: Params): boolean
{
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const k of keysA)
    {
        if (a[k] !== b[k]) return false;
    }
    return true;
}
