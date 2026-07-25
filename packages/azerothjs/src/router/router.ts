/**
 * MODULE: router/router
 *
 * createRouter is the orchestrator; every other router export (Link, Routes, Outlet, useRoute,
 * useParams, useQuery, useLoader) is a thin reactive layer over the Router it returns.
 *
 * FLOW: navigate() pushes/replaces on the HistoryAdapter; the adapter's subscribe callback updates
 * one internal state signal; the `location` and `match` memos derive from it - so the URL is
 * matched once per change and downstream reads are near-free structural reads.
 *
 * LIFECYCLE: the history subscription is registered with the surrounding createRoot via
 * onRootDispose, so it (and, if it was the last subscriber, the native popstate listener) is torn
 * down on unmount. createRouter therefore MUST run inside a createRoot - render() wraps the tree
 * in one, so a top-level component is covered; standalone use (tests) must wrap it explicitly.
 *
 * MATCHING: at construction the (possibly nested) route tree is flattened to one entry per leaf
 * (a compiled full-path matcher + the root-to-leaf chain for <Outlet>); matching is a linear
 * first-hit scan, so config order defines priority - matching every other router on the web. The
 * leaf/path/base/state internals below carry their own comments.
 */

import type { Getter, Resource } from '../reactivity/index.ts';
import {
    createSignal,
    createMemo,
    createEffect,
    createResource,
    onRootDispose,
    untrack
} from '../reactivity/index.ts';
import type {
    HistoryAdapter,
    NavigateOptions,
    NavigateTarget,
    Params,
    Query,
    Route,
    RouteComponent,
    RouteLoaderArgs,
    RouteLocation,
    RouteMatch,
    RouterConfig
} from './types.ts';
import { compilePath, type PathMatcher } from './path-pattern.ts';
import { parseQuery, stringifyQuery } from './query.ts';
import { createBrowserHistory } from './history.ts';
import { shallowEqualRecord } from './shallow-equal.ts';

/** The cause of a location change; see {@link Router.navigationKind}. */
export type NavigationKind = 'push' | 'replace' | 'pop';

/**
 * Resolved lazy-route components (or their load errors), cached per Route object for
 * the process lifetime - a chunk downloads once no matter how many routers or
 * navigations touch the route.
 *
 * @internal
 */
const LAZY_CACHE = new WeakMap<Route, { component: RouteComponent } | { error: unknown }>();

/**
 * Resolves a route's component: the direct `component`, or the `lazy` chunk (fetched
 * once, cached). Exposed for the server (`matchAndLoad` pre-resolves lazy chains before
 * a synchronous SSR render) and for ahead-of-need prefetching (hover, viewport).
 */
export async function resolveRouteComponent(route: Route): Promise<RouteComponent>
{
    if (route.component !== undefined)
    {
        return route.component;
    }
    const cached = LAZY_CACHE.get(route);
    if (cached !== undefined)
    {
        if ('component' in cached)
        {
            return cached.component;
        }
        throw cached.error;
    }
    if (route.lazy === undefined)
    {
        throw new Error(`Route "${ route.path }" has neither component nor lazy - createRouter validation should have caught this.`);
    }
    try
    {
        const loaded = await route.lazy();
        const component = typeof loaded === 'function' ? loaded : loaded.default;
        LAZY_CACHE.set(route, { component });
        return component;
    }
    catch (error)
    {
        LAZY_CACHE.set(route, { error });
        throw error;
    }
}

/**
 * The route's usable component NOW: direct, or the resolved lazy chunk. Throws the
 * chunk's LOAD ERROR when the fetch failed (an `<ErrorBoundary>` above `<Routes>`
 * catches it) and a plain error when called before the chunk arrived - `<Routes>`
 * guards on `router.chainReady()` so that never happens in the render path.
 *
 * @internal Exported for routes.ts and the SSR handoff.
 */
export function componentOf(route: Route): RouteComponent
{
    if (route.component !== undefined)
    {
        return route.component;
    }
    const cached = LAZY_CACHE.get(route);
    if (cached === undefined)
    {
        throw new Error(`Route "${ route.path }": the lazy chunk has not resolved yet. `
            + 'On the server, await matchAndLoad (or resolveRouteComponent) before rendering.');
    }
    if ('error' in cached)
    {
        throw cached.error;
    }
    return cached.component;
}

/**
 * Boot-time shape check: every route carries exactly ONE of `component` / `lazy`.
 * A silent both-or-neither would surface as a confusing render-time failure; the
 * boot error names the route.
 *
 * @internal
 */
function validateRouteTree(routes: Route[]): void
{
    for (const route of routes)
    {
        const hasComponent = route.component !== undefined;
        const hasLazy = route.lazy !== undefined;
        if (hasComponent === hasLazy)
        {
            throw new Error(`Route "${ route.path }" must declare exactly one of \`component\` or \`lazy\`; `
                + `it has ${ hasComponent ? 'both' : 'neither' }.`);
        }
        if (route.children !== undefined)
        {
            validateRouteTree(route.children);
        }
    }
}

/**
 * The object returned by `createRouter()`.
 *
 * Holds the reactive location/match signals and exposes imperative navigation
 * methods. Pass it to `<Link>`, `<Route>`, `<Outlet>`, or to the
 * `useRoute`/`useParams`/`useQuery` composables.
 */
export interface Router
{
    /**
     * Reactive snapshot of the current location.
     *
     * Updates whenever the URL changes, programmatically or via the browser's
     * back/forward buttons.
     */
    location: Getter<RouteLocation>;

    /**
     * The currently matched route, or `null` if no route matches.
     *
     * Walked by `<Outlet>` for nested layouts. A memo with structural
     * equality, so cosmetic location changes (e.g. only the hash) don't
     * invalidate it.
     */
    match: Getter<RouteMatch | null>;

    /**
     * One resource PER ROUTE LEVEL (index 0 = root of the matched chain), sized
     * to the deepest chain in the route table. On a match change EVERY level
     * with a loader starts simultaneously - parallel by construction. A level
     * whose route has no loader (or is beyond the current chain) idles:
     * `data()` undefined, `loading()` false.
     *
     * Prefer `useLoader()` (nearest level inside a route component, typed via a
     * route handle) over indexing this directly.
     */
    loaders: ReadonlyArray<Resource<unknown>>;

    /**
     * Reactive: true while ANY of the current navigation's work is in flight -
     * a level loader still loading or a lazy route chunk still downloading.
     * The pending-indicator signal (top bars, spinners).
     */
    pending: Getter<boolean>;

    /**
     * Reactive: false while the matched chain contains a lazy route whose chunk
     * has not arrived yet. `<Routes>` holds the PREVIOUS screen until this goes
     * true, so navigation to a code-split route never flashes an empty frame.
     * @internal Consumed by `<Routes>`; user code wants {@link Router.pending}.
     */
    chainReady: Getter<boolean>;

    /**
     * What CAUSED the latest location change: `'push'` (navigate / a Link),
     * `'replace'`, or `'pop'` (the browser's own back/forward - the two are not
     * distinguishable without stamping history state, so they share one honest
     * name). A plain read, not reactive - consult it INSIDE a reaction to the
     * location, e.g. to pick a directional route-transition name.
     */
    navigationKind: () => NavigationKind;

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
    navigate: (to: NavigateTarget, options?: NavigateOptions) => void;

    /**
     * Replaces the current history entry with `to`.
     *
     * Equivalent to `navigate(to, { replace: true })` but cannot be inverted by
     * setting `replace: false`. Useful for redirects where you don't want the
     * original URL on the back stack.
     *
     * @example
     * ```ts
     * // Redirect after login without leaving the login page on the back stack
     * router.replace('/dashboard');
     * ```
     */
    replace: (to: NavigateTarget, options?: Omit<NavigateOptions, 'replace'>) => void;

    /** Steps back one history entry, same as the browser's Back button. */
    back: () => void;

    /** Steps forward one history entry, same as the browser's Forward button. */
    forward: () => void;

    /**
     * Resolves a `NavigateTarget` to the actual URL string that belongs in an
     * `<a href>`: the base-relative path with the configured `base` prefix
     * applied. External targets (`https://...`, `mailto:...`) are returned
     * unchanged.
     *
     * `<Link>` uses this so its rendered `href` points at the real
     * (base-prefixed) URL while app code keeps writing base-relative `to`
     * values.
     *
     * @example
     * ```ts
     * // With base: '/app'
     * router.href('/users/42');        // -> '/app/users/42'
     * router.href('https://x.com');    // -> 'https://x.com' (unchanged)
     * ```
     */
    href: (to: NavigateTarget) => string;
}

/**
 * Internal flat-list entry produced from the (possibly nested) input route
 * tree. One entry per leaf.
 *
 * @internal
 */
interface LeafEntry
{
    matcher: PathMatcher;
    /** Root-to-leaf chain, used by `<Outlet>`. */
    matched: Route[];
}

/**
 * Joins a parent path and a child path into a full path.
 *
 * Handles the common edge cases so the user can write either leading-slash or
 * naked child paths and get a sane result.
 *
 *   joinPaths('/',  ''       )  -> '/'
 *   joinPaths('/',  'about'  )  -> '/about'
 *   joinPaths('/users', ''   )  -> '/users'
 *   joinPaths('/users', ':id')  -> '/users/:id'
 *   joinPaths('/users/', ':id') -> '/users/:id'
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
 * Walks the (possibly nested) route tree and emits one entry per leaf, where
 * each entry's matcher is built from the joined parent paths and the `matched`
 * array is the root-to-leaf chain.
 *
 * Internal nodes (routes that have children) become layouts: they're never
 * matched on their own and only appear inside the `matched` chain of one of
 * their descendants.
 *
 * @internal
 */
export function flattenRoutes(
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
 * `fullPath` is treated as `pathname[?search][#hash]`. Any of the three may be
 * empty. We don't use the URL constructor because it requires a base, and we
 * don't want to invent one.
 *
 * @internal
 */
export function splitFullPath(fullPath: string): { pathname: string; search: string; hash: string }
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
 * Converts a `NavigateTarget` (string or structured) into a canonical
 * `fullPath` string.
 *
 * Adds the leading `?` to a built search and the leading `#` to a hash if the
 * caller forgot. We never strip these: they're part of the path's shape and
 * stripping them would silently change semantics.
 *
 * Exported so `<Link>` can render the same string into the `href` attribute
 * that `navigate()` would push to history. Both code paths produce the same
 * canonical form.
 *
 * @example
 * ```ts
 * targetToFullPath('/users/42');                              // -> '/users/42'
 * targetToFullPath({ pathname: '/search', query: { q: 'js' } }); // -> '/search?q=js'
 * targetToFullPath({ pathname: '/docs', hash: 'intro' });     // -> '/docs#intro'
 * ```
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
 * Matches a string starting with a URL scheme (`https:`, `mailto:`, `tel:`,
 * ...) or a protocol-relative URL (`//host`). Such targets are external: the
 * base prefix must not be applied to them, and `<Link>` does not intercept
 * their clicks.
 *
 * Lives here (rather than in link.ts) so both the router's base-resolution and
 * the link's click logic share one definition.
 *
 * @example
 * ```ts
 * EXTERNAL_URL.test('https://example.com'); // -> true
 * EXTERNAL_URL.test('mailto:me@x.com');     // -> true
 * EXTERNAL_URL.test('//cdn.example.com');   // -> true
 * EXTERNAL_URL.test('/users/42');           // -> false (internal app path)
 * ```
 */
export const EXTERNAL_URL: RegExp = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Normalizes a configured base path into a canonical prefix:
 *   - `undefined` / `''` / `'/'`     -> `''` (no base)
 *   - `'app'` / `'/app'` / `'/app/'` -> `'/app'`
 *
 * The result is either empty or starts with `/` and has no trailing slash, so
 * it can be concatenated directly in front of an absolute app path.
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
 * Bundling these into one signal means we match the URL exactly once per change
 * (in the history listener); the memos that read it are then near-free
 * structural reads.
 *
 * @internal
 */
interface InternalState
{
    fullPath: string;
    pathname: string;
    search: string;
    hash: string;
    /** Cached match result, used by both `location.params` and the `match` memo. */
    matched: RouteMatch | null;
}

/**
 * createRouter
 *
 * PURPOSE:
 * Builds a {@link Router} from a route config: reactive `location`/`match`/`loader` plus imperative
 * navigate/replace/back/forward/href.
 *
 * WHY IT EXISTS:
 * Hand-rolling client routing means wiring the popstate listener, push/replace, URL matching,
 * nested layouts, loader cancellation, base-path handling, AND remembering to tear it all down -
 * fiddly and leak-prone. createRouter packages all of it as reactive signals with automatic
 * cleanup tied to the surrounding root.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; the orchestrator the components ({@link Link}/Routes/Outlet) and composables
 * (useRoute/useParams/useQuery/useLoader) read. Must run inside a createRoot so the history
 * subscription is disposed on unmount (render() provides one).
 *
 * INPUT CONTRACT:
 * - config.routes: a (possibly nested) route tree; order defines match priority.
 * - config.base: optional base path; the router works in base-relative space internally.
 * - config.history: optional HistoryAdapter (defaults to browser history); config.mode is reserved.
 *
 * OUTPUT CONTRACT:
 * - A Router: `location()`/`match()` getters, a `loader` resource, and navigate/replace/back/
 *   forward/href methods. Cleanup is automatic when the surrounding root disposes.
 *
 * WHY THIS DESIGN:
 * One internal state signal updated by the history listener matches the URL once per change; the
 * `match` memo uses structural equality so cosmetic URL changes (e.g. hash-only) do not invalidate
 * downstream; the loader is a createResource keyed on `match` (free cancellation + race guard);
 * base is handled by prefix-on-write / strip-on-read, so routes, params, and <Link to> stay
 * base-relative.
 *
 * WHEN TO USE:
 * At the app root (or a subtree) to drive client-side routing.
 *
 * WHEN NOT TO USE:
 * For a single external link (use a plain <a>). Never call it outside a createRoot - the popstate
 * subscription would leak.
 *
 * EDGE CASES:
 * - A URL outside the configured base does not match (location still reflects the raw pathname).
 * - No match, or a matched route without a loader, leaves `loader` in the idle (no-key) state.
 * - Route order is priority: the first matching leaf wins.
 *
 * PERFORMANCE NOTES:
 * The URL is matched once per change; `location`/`match` are structural memo reads; navigate runs
 * untracked so calling it inside an effect adds no subscriptions.
 *
 * DEVELOPER WARNING:
 * Must be created inside a createRoot or the history subscription (and native popstate listener)
 * leaks. Route order matters - put more specific routes before catch-alls.
 *
 * @param config - The {@link RouterConfig}: routes (nested), optional base/history/mode.
 * @returns A {@link Router}.
 * @see {@link Link}
 * @example
 * const router = createRouter({
 *   routes: [{ path: '/', component: Home }, { path: '/users/:id', component: UserPage }]
 * });
 * router.navigate('/users/42');
 * router.location().params.id; // '42'
 */
export function createRouter(config: RouterConfig): Router
{
    validateRouteTree(config.routes);
    const leaves = flattenRoutes(config.routes);
    const history: HistoryAdapter = config.history ?? createBrowserHistory();

    // The deepest possible chain, known statically: one loader resource per level
    // is created up front (resources need the surrounding ownership scope).
    const maxDepth = leaves.reduce((deepest, entry) => Math.max(deepest, entry.matched.length), 0);

    // Canonical base prefix ('' when there's no base). The router works in
    // base-relative space internally: route patterns, location.pathname,
    // params, and <Link to> are all base-relative. The prefix is added only
    // when writing to history and stripped only when reading from it.
    const base = normalizeBase(config.base);

    // Strips the base prefix off a raw browser pathname, returning the
    // base-relative path, or null when the pathname is outside the configured
    // base (so nothing should match). The `base + '/'` boundary check stops
    // `/app` from swallowing `/application`.
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

    // Resolves a NavigateTarget to the final URL string used for history writes
    // and <Link> hrefs: base-prefixed for internal paths, untouched for
    // external URLs.
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

            const leaf = entry.matched[entry.matched.length - 1];
            if (leaf === undefined)
            {
                continue; // matched chains are never empty; satisfies the indexed-access check
            }

            return {
                route: leaf,
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

        // Match (and expose) in base-relative space. When the URL is outside
        // the base, `inner` is null so nothing matches, and we fall back to the
        // raw pathname for the location snapshot.
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

    // Initial state, read straight from the live URL.
    const [state, setState] = createSignal<InternalState>(buildState(history.current()));

    // What CAUSED the latest location change. performNavigate stamps a pending
    // kind just before the adapter call (whose subscribers run synchronously);
    // a change arriving with NO pending stamp came from the browser itself -
    // popstate, i.e. back/forward - and reads as 'pop'.
    let pendingKind: 'push' | 'replace' | null = null;
    let lastKind: NavigationKind = 'push';

    // React to URL changes.
    const unsubHistory = history.subscribe((fullPath) =>
    {
        lastKind = pendingKind ?? 'pop';
        pendingKind = null;
        setState(buildState(fullPath));
    });

    // Cleanup when the surrounding root tears down. If this call happens
    // outside a root, the disposer is silently dropped (see onRootDispose docs)
    // and the popstate listener will leak; the JSDoc on createRouter spells out
    // the requirement.
    onRootDispose(unsubHistory);

    // A user-facing snapshot. Re-derives only when state changes.
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
     * Bundles everything one level's loader fetcher needs. Keyed by the match
     * object identity: a match change produces new triggers, so every level's
     * createResource re-fetches (in parallel - each level reacts independently).
     *
     * @internal
     */
    interface LoaderTrigger
    {
        match: RouteMatch;
        level: number;
        loader: (args: RouteLoaderArgs) => Promise<unknown>;
        params: Params;
        query: Query;
    }

    /**
     * The matched route, with structural equality so cosmetic URL changes (e.g.
     * only the hash) don't invalidate downstream effects that watch the matched
     * route.
     */
    const match = createMemo<RouteMatch | null>(
        () => state().matched,
        {
            equals: (a, b) =>
            {
                // `a` and `b` are the previous and next match values, never the
                // memo's pre-init placeholder, because a memo's first computed
                // value always bypasses `equals`. Either side can be `null`
                // ("no route matched"), so the `== null` branch settles that
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
                return shallowEqualRecord(a.params, b.params);
            }
        }
    );

    // Hydration/SSR handoff: server-loaded data is adopted for the INITIAL location only -
    // and only when its path (pathname + search) is EXACTLY what this router booted at AND
    // the wire-format version matches, so a stale payload, a URL mismatch, or an old-server
    // shape all fall back to a normal fetch instead of serving the wrong data. Adoption
    // seeds each LEVEL's resource as already settled: data is synchronously readable during
    // an SSR render and the hydrating client never refetches what the server just loaded.
    const seed = config.initialLoaderData;
    const initialState = untrack(state);
    const adopt = seed !== undefined
        && seed.version === 2
        && Array.isArray(seed.data)
        && seed.path === initialState.pathname + initialState.search;

    // Per-navigation promise slots, keyed by match identity: each level's fetcher
    // deposits its promise so DESCENDANT levels can await `parent`. Levels react to
    // the same match memo in creation order (root first), so an ancestor's slot is
    // always deposited before a descendant's fetcher reads it.
    let flightMatch: RouteMatch | null = null;
    let flightSlots: Array<Promise<unknown> | undefined> = [];
    function flightFor(m: RouteMatch): Array<Promise<unknown> | undefined>
    {
        if (flightMatch !== m)
        {
            flightMatch = m;
            flightSlots = [];
        }
        return flightSlots;
    }

    // One resource per level; each level with a loader starts the moment the match
    // changes - all levels IN PARALLEL by construction. createResource handles
    // cancellation and race-guarding per level, exactly as it did for the old
    // single leaf loader.
    const loaders: Array<Resource<unknown>> = [];
    for (let level = 0; level < maxDepth; level++)
    {
        loaders.push(createResource<unknown, LoaderTrigger>(
            () =>
            {
                const m = match();
                const route = m?.matched[level];
                if (m === null || route === undefined || !route.loader)
                {
                    return null;
                }
                return { match: m, level, loader: route.loader, params: m.params, query: parseQuery(untrack(state).search) };
            },
            async (trigger, signal) =>
            {
                const slots = flightFor(trigger.match);
                // `parent` is the nearest ANCESTOR WITH A LOADER's promise; loaderless
                // levels leave their slot empty and are skipped.
                let parent: Promise<unknown> = Promise.resolve(undefined);
                for (let above = trigger.level - 1; above >= 0; above--)
                {
                    const slot = slots[above];
                    if (slot !== undefined)
                    {
                        parent = slot;
                        break;
                    }
                }
                const promise = trigger.loader({ params: trigger.params, query: trigger.query, signal, parent });
                slots[trigger.level] = promise;
                return promise;
            },
            adopt && (seed.data)[level] !== undefined
                ? { initialValue: (seed.data)[level] }
                : undefined
        ));
    }

    // Lazy chunks: resolution starts the moment a match containing an unresolved
    // lazy route lands (racing the same levels' loaders); arrivals bump a version
    // signal so chainReady/pending re-evaluate.
    const [lazyVersion, setLazyVersion] = createSignal(0);
    createEffect(() =>
    {
        const m = match();
        if (m === null)
        {
            return;
        }
        for (const route of m.matched)
        {
            if (route.lazy !== undefined && !LAZY_CACHE.has(route))
            {
                void resolveRouteComponent(route).catch(() => undefined).then(() =>
                {
                    setLazyVersion((v) => v + 1);
                });
            }
        }
    });

    /** True when every route in the current chain has a usable component. */
    const chainReady = createMemo<boolean>(() =>
    {
        lazyVersion();
        const m = match();
        if (m === null)
        {
            return true;
        }
        return m.matched.every((route) => route.lazy === undefined || LAZY_CACHE.has(route));
    });

    const pending = createMemo<boolean>(() =>
        !chainReady() || loaders.some((resource) => resource.loading()));

    function performNavigate(target: NavigateTarget, options: NavigateOptions): void
    {
        // resolve() applies the base prefix (internal targets only), so history
        // always holds the real browser URL.
        const fullPath = resolve(target);

        pendingKind = options.replace ? 'replace' : 'push';
        if (options.replace)
        {
            history.replace(fullPath, options.state);
        }
        else
        {
            history.push(fullPath, options.state);
        }
        pendingKind = null;

        // Optional opt-in scroll to top; the router doesn't restore scroll
        // automatically. Users who need bespoke scroll behavior can subscribe
        // to `location` instead. Guarded for SSR / memory-history: the router runs
        // server-side (createMemoryHistory) where there is no `window`.
        if (options.scroll && typeof window !== 'undefined')
        {
            window.scrollTo({ top: 0, left: 0 });
        }
    }

    return {
        location,
        match,
        loaders,
        pending,
        chainReady,
        navigationKind: () => lastKind,
        navigate(to, options = {}): void
        {
            // untrack so navigate can be called from inside an effect without
            // that effect subscribing to whatever signals the user might
            // evaluate while building `to`.
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
