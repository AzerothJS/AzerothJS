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

import type { Getter, Resource } from '@azerothjs/reactivity';
import {
    createSignal,
    createMemo,
    createResource,
    onRootDispose,
    untrack
} from '@azerothjs/reactivity';
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
     * Resource holding the matched route's loader output.
     *
     * The resource's source is the `match` memo. When the match
     * changes (route or params change), the previous loader's
     * `AbortSignal` fires and the new route's loader runs. When
     * no route matches, or the matched route has no loader, the
     * resource is in the "no key" state — `data()` is undefined
     * and `loading()` is false.
     *
     * Typed as `Resource<unknown>` because the router can't know
     * which leaf's loader is active at compile time. Use the
     * `useLoader<T>(router)` composable to apply a per-call cast.
     */
    loader: Resource<unknown>;

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

    /**
     * Resolves a `NavigateTarget` to the actual URL string that
     * belongs in an `<a href>` — i.e. the base-relative path with
     * the configured `base` prefix applied. External targets
     * (`https://…`, `mailto:…`) are returned unchanged.
     *
     * `<Link>` uses this so its rendered `href` points at the real
     * (base-prefixed) URL while app code keeps writing base-relative
     * `to` values.
     *
     * @example
     * ```ts
     * // With base: '/app'
     * router.href('/users/42');        // → '/app/users/42'
     * router.href('https://x.com');    // → 'https://x.com' (unchanged)
     * ```
     */
    href(to: NavigateTarget): string;
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
    if (p.length > 1 && p.endsWith('/'))
    {
        p = p.slice(0, -1);
    }

    let c = child;
    if (c.startsWith('/'))
    {
        c = c.slice(1);
    }

    if (c === '')
    {
        return p === '' ? '/' : p;
    }
    if (p === '' || p === '/')
    {
        return '/' + c;
    }
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
    if (typeof target === 'string')
    {
        return target;
    }

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
 * Matches a string starting with a URL scheme (`https:`, `mailto:`,
 * `tel:`, …) or a protocol-relative URL (`//host`). Such targets
 * are external — the base prefix must NOT be applied to them, and
 * `<Link>` does not intercept their clicks.
 *
 * Lives here (rather than in link.ts) so both the router's
 * base-resolution and the link's click logic share one definition.
 */
export const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Normalizes a configured base path into a canonical prefix:
 *   - `undefined` / `''` / `'/'`  → `''` (no base)
 *   - `'app'` / `'/app'` / `'/app/'` → `'/app'`
 *
 * The result either is empty or starts with `/` and has no trailing
 * slash, so it can be concatenated directly in front of an absolute
 * app path.
 *
 * @internal
 */
function normalizeBase(base: string | undefined): string
{
    if (!base || base === '/')
    {
        return '';
    }

    let b = base;
    if (!b.startsWith('/'))
    {
        b = '/' + b;
    }
    if (b.endsWith('/'))
    {
        b = b.slice(0, -1);
    }
    return b;
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

    // Canonical base prefix (`''` when there's no base). The router
    // works in BASE-RELATIVE space internally: route patterns,
    // `location.pathname`, params, and `<Link to>` are all
    // base-relative. The prefix is added only when writing to
    // history and stripped only when reading from it.
    const base = normalizeBase(config.base);

    /**
     * Strips the base prefix off a raw browser pathname, returning
     * the base-relative path — or `null` when the pathname is
     * OUTSIDE the configured base (so nothing should match). The
     * `base + '/'` boundary check stops `/app` from swallowing
     * `/application`.
     */
    function stripBase(rawPathname: string): string | null
    {
        if (base === '')
        {
            return rawPathname;
        }
        if (rawPathname === base)
        {
            return '/';
        }
        if (rawPathname.startsWith(base + '/'))
        {
            return rawPathname.slice(base.length);
        }
        return null;
    }

    /** Prefixes the base onto a base-relative, absolute app path. */
    function applyBase(relPath: string): string
    {
        return base === '' ? relPath : base + relPath;
    }

    /**
     * Resolves a `NavigateTarget` to the final URL string used for
     * history writes and `<Link>` hrefs: base-prefixed for internal
     * paths, untouched for external URLs.
     */
    function resolve(target: NavigateTarget): string
    {
        const full = targetToFullPath(target);
        return EXTERNAL_URL.test(full) ? full : applyBase(full);
    }

    function matchPathname(pathname: string): RouteMatch | null
    {
        for (const entry of leaves)
        {
            const result = entry.matcher.match(pathname);
            if (result === null)
            {
                continue;
            }

            return {
                route: entry.matched[entry.matched.length - 1],
                params: result.params,
                matched: entry.matched,
                pathname
            };
        }
        return null;
    }

    function buildState(rawFullPath: string): InternalState
    {
        const { pathname: rawPathname, search, hash } = splitFullPath(rawFullPath);

        // Match (and expose) in base-relative space. When the URL is
        // outside the base, `inner` is null → nothing matches, and we
        // fall back to the raw pathname for the location snapshot.
        const inner = stripBase(rawPathname);
        const pathname = inner ?? rawPathname;

        return {
            fullPath: pathname + search + hash,
            pathname,
            search,
            hash,
            matched: inner === null ? null : matchPathname(inner)
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
     * Bundles everything the loader fetcher needs: the loader
     * function, the params it should receive, and a stable
     * "trigger" handle that lives only as long as the current
     * match. When the match changes, the source returns a new
     * trigger object → createResource re-fetches.
     *
     * @internal
     */
    interface LoaderTrigger
    {
        loader: (args: { params: Params; signal: AbortSignal }) => Promise<unknown>;
        params: Params;
    }

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
                // `a` and `b` are the previous and next match values
                // — never the memo's pre-init placeholder, because a
                // memo's first computed value always bypasses
                // `equals`. Either side can be `null` ("no route
                // matched"), so the `== null` branch settles that
                // before the structural route+params comparison.
                if (a === b)
                {
                    return true;
                }
                if (a == null || b == null)
                {
                    return false;
                }
                if (a.route !== b.route)
                {
                    return false;
                }
                return shallowEqualParams(a.params, b.params);
            }
        }
    );

    // ── Loader resource ──────────────────────────────────────
    //
    // Source returns a `LoaderTrigger` when the matched leaf has
    // a loader, and `null` otherwise (no match, or matched route
    // declines to load). createResource handles cancellation +
    // race-condition guarding so navigation away from a slow
    // loader doesn't paint stale data.

    const loader = createResource<unknown, LoaderTrigger>(
        () =>
        {
            const m = match();
            if (m === null)
            {
                return null;
            }
            const leaf = m.matched[m.matched.length - 1];
            if (!leaf.loader)
            {
                return null;
            }
            return { loader: leaf.loader, params: m.params };
        },
        async (trigger, signal) =>
        {
            return trigger.loader({ params: trigger.params, signal });
        }
    );

    // ── Navigation ───────────────────────────────────────────

    function performNavigate(target: NavigateTarget, options: NavigateOptions): void
    {
        // resolve() applies the base prefix (internal targets only),
        // so history always holds the real browser URL.
        const fullPath = resolve(target);

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
        loader,
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
        },
        href(to): string
        {
            return resolve(to);
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
    if (keysA.length !== keysB.length)
    {
        return false;
    }

    for (const k of keysA)
    {
        if (a[k] !== b[k])
        {
            return false;
        }
    }
    return true;
}
