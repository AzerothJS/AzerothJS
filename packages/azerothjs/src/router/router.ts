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
    isStringMode,
    onRootDispose,
    untrack
} from '../reactivity/index.ts';
import type {
    GuardContext,
    HistoryAdapter,
    NavigateOptions,
    NavigateTarget,
    NavigationKind,
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
import { isRedirect } from './redirect.ts';
import { parseQuery, stringifyQuery } from './query.ts';
import { createBrowserHistory } from './history.ts';
import { shallowEqualRecord } from './shallow-equal.ts';

export type { NavigationKind } from './types.ts';

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

    /** Whether route-change focus management is on (config `focus`, default true). @internal Consumed by `<Routes>`. */
    focusManagement: boolean;

    /**
     * Registers a LEAVE BLOCKER (the unsaved-form case): before any navigation
     * commits, every blocker runs with `{ from, to, kind }`; returning `false`
     * (or resolving to it) keeps the user where they are. Returns the
     * unregister function. Browser back/forward blocking is BEST-EFFORT and
     * SYNCHRONOUS-ONLY (the History API cannot truly veto a pop: the router
     * undoes the move, so use `window.confirm` - synchronous - for pop
     * prompts; an async verdict counts as allow on pop). Leaving the site
     * entirely is `beforeunload` territory - register your own listener.
     *
     * @example
     * const unblock = router.block(({ from }) => form.dirty() ? window.confirm('Discard changes?') : true);
     */
    block: (blocker: (context: { from: RouteLocation; to: NavigateTarget | null; kind: NavigationKind }) => boolean | Promise<boolean>) => () => void;

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
 * their clicks. Callers classify through {@link isExternalUrl}, which
 * normalizes the candidate the way a browser normalizes an href first.
 *
 * @internal
 */
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * ASCII whitespace and C0 controls (plus space), which browsers STRIP when resolving an
 * href: `java\tscript:` and a leading-newline scheme both reach the browser as a real
 * scheme. The classifier must strip them too, or it disagrees with the browser - calling
 * such a string internal, intercepting the click, and pushing a scheme URL into history
 * as if it were an app path.
 *
 * @internal
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point: browsers remove them from an href before resolving its scheme
const URL_CONTROL_CHARS = /[\x00-\x20]/g;

/**
 * Whether a navigation target is EXTERNAL (scheme or protocol-relative), judged on the
 * string a browser would actually resolve: control characters and whitespace are stripped
 * before the scheme test, so the classifier and the rendered `href` can never disagree.
 *
 * Lives here (rather than in link.ts) so the router's base-resolution and the link's
 * click logic share one definition.
 *
 * @example
 * ```ts
 * isExternalUrl('https://example.com'); // -> true
 * isExternalUrl('java\tscript:x');      // -> true (the browser sees a scheme; so do we)
 * isExternalUrl('/users/42');           // -> false (internal app path)
 * ```
 */
export function isExternalUrl(candidate: string): boolean
{
    return EXTERNAL_URL.test(candidate.replace(URL_CONTROL_CHARS, ''));
}

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
    /** How this location came to be; rides into RouteLocation. */
    kind: NavigationKind;
    /** Pop distance (see RouteLocation.delta). */
    delta: number;
    /** The entry's stamp (see RouteLocation.key). */
    key: string;
}

/** @internal What the router stores in each history entry's state. */
interface StampedState
{
    __az: { key: string; index: number };
    state: unknown;
}

/** @internal The stamp of an entry's state, or null for unstamped/foreign entries. */
function stampOf(state: unknown): { key: string; index: number } | null
{
    const az = (state as StampedState | null | undefined)?.__az;
    return az !== undefined && typeof az.key === 'string' && typeof az.index === 'number' ? az : null;
}

/** @internal Monotonic entry keys, process-wide (stable enough; stamps live per entry). */
let nextEntryKey = 0;
function freshKey(): string
{
    return `az${ ++nextEntryKey }`;
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
        return isExternalUrl(full) ? full : applyBase(full);
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

    function buildState(rawFullPath: string, kind: NavigationKind, delta: number, key: string): InternalState
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
            matched: inner === null ? null : matchPathname(inner),
            kind,
            delta,
            key
        };
    }

    // ENTRY STAMPS. Each router-written history entry carries { key, index } in its
    // state (the user's own state rides beside it, under `.state`), which is what
    // makes pop DIRECTION (delta) knowable and gives scroll restoration its keys.
    // The index/key trackers follow the CURRENT entry.
    const bootStamp = stampOf(history.state?.());
    let currentIndex = bootStamp?.index ?? 0;
    let currentKey = bootStamp?.key ?? freshKey();
    if (bootStamp === null && history.state !== undefined)
    {
        // Stamp the entry the router booted on (no subscriber is attached yet, so
        // this replace notifies nobody). A revisit of this entry then restores.
        history.replace(history.current(), { __az: { key: currentKey, index: 0 }, state: undefined } satisfies StampedState);
    }

    // Initial state, read straight from the live URL.
    const [state, setState] = createSignal<InternalState>(
        buildState(history.current(), 'push', 0, currentKey));

    // What CAUSED the latest location change. performNavigate stamps a pending
    // kind just before the adapter call (whose subscribers run synchronously);
    // a change arriving with NO pending stamp came from the browser itself -
    // popstate, i.e. back/forward - and reads as 'pop'.
    let pendingKind: 'push' | 'replace' | null = null;

    // React to URL changes.
    let suppressPop = false;
    const unsubHistory = history.subscribe((fullPath) =>
    {
        const kind: NavigationKind = pendingKind ?? 'pop';
        pendingKind = null;

        const stamp = stampOf(history.state?.());
        let delta = 0;
        if (kind === 'pop' && stamp !== null)
        {
            delta = stamp.index - currentIndex;
        }

        // Pop blocking, best-effort: the browser already moved, so a block means
        // UNDOING the move (whose own pop must not re-consult the blockers). Only
        // synchronous verdicts can hold a pop - see Router.block.
        if (kind === 'pop')
        {
            if (suppressPop)
            {
                suppressPop = false;
                currentIndex = stamp?.index ?? currentIndex;
                currentKey = stamp?.key ?? currentKey;
                return;
            }
            if (blockers.size > 0)
            {
                const context = { from: untrack(location), to: null, kind };
                const blocked = [...blockers].some((blocker) => blocker(context) === false);
                if (blocked)
                {
                    suppressPop = true;
                    if (delta < 0)
                    {
                        history.forward();
                    }
                    else
                    {
                        history.back();
                    }
                    return;
                }
            }
        }

        if (kind === 'pop')
        {
            recordScroll();
        }
        currentIndex = stamp?.index ?? (kind === 'push' ? currentIndex + 1 : currentIndex);
        currentKey = stamp?.key ?? freshKey();

        setState(buildState(fullPath, kind, delta, currentKey));
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
            fullPath: s.fullPath,
            navigationKind: s.kind,
            delta: s.delta,
            key: s.key
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
    // Structural match equality: cosmetic URL changes (hash-only) must not invalidate
    // downstream effects. `a`/`b` are previous/next values (a memo's first computed
    // value bypasses `equals`); either side can be null ("no route matched").
    const matchEquals = (a: RouteMatch | null, b: RouteMatch | null): boolean =>
    {
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
    };

    /** The URL's raw match, BEFORE guards - internal; everything renders off `match`. */
    const rawMatch = createMemo<RouteMatch | null>(() => state().matched, { equals: matchEquals });

    // Navigation machinery the guard effect below can reach on its FIRST synchronous run
    // (a guard that vetoes or redirects the boot URL calls performNavigate immediately).
    // These bindings must exist before that run - the scroll/blocker state is declared here,
    // ahead of the guard effect, rather than beside the scroll/block code lower down, so a
    // boot-time guard redirect cannot hit a temporal-dead-zone ReferenceError.
    const scrollManaged = config.scroll !== false && typeof window !== 'undefined';
    const scrollPositions = new Map<string, { x: number; y: number }>();
    let navScrollOverride: boolean | undefined = undefined;
    const blockers = new Set<(context: { from: RouteLocation; to: NavigateTarget | null; kind: NavigationKind }) => boolean | Promise<boolean>>();

    // The GUARDED match - the public reactive view. <Routes> and every level's loader
    // resource key off this signal, so a navigation that a guard vetoes or redirects
    // never renders and never loads. Guardless chains accept SYNCHRONOUSLY in the same
    // flush (no timing change for the common case).
    const [match, setMatch] = createSignal<RouteMatch | null>(null, { equals: matchEquals });
    const [guarding, setGuarding] = createSignal(false);
    let guardRun = 0;
    let lastAcceptedFull: string | null = null;
    let lastAcceptedLocation: RouteLocation | null = null;

    createEffect(() =>
    {
        const m = rawMatch();
        const run = ++guardRun;
        const s = untrack(state);

        const finish = (): void =>
        {
            if (run === guardRun)
            {
                setGuarding(false);
            }
        };
        const accept = (value: RouteMatch | null): void =>
        {
            finish();
            lastAcceptedFull = applyBase(s.fullPath);
            lastAcceptedLocation = untrack(location);
            setMatch(value);
        };
        const veto = (): void =>
        {
            finish();
            if (lastAcceptedFull !== null)
            {
                // Restore the previous URL in place: the vetoed entry never renders and
                // does not survive on the stack. The restored route's guards re-run and
                // pass again (they passed before) - guards must be side-effect-free.
                untrack(() => performNavigate(lastAcceptedFull as string, { replace: true }));
            }
            else
            {
                setMatch(null); // boot veto: nothing to restore; the fallback renders
            }
        };
        // True = pass; false = this navigation is settled (veto or redirect performed).
        const applyVerdict = (verdict: unknown): boolean =>
        {
            if (verdict === false)
            {
                veto();
                return false;
            }
            if (verdict === true || verdict === undefined || verdict === null)
            {
                return true;
            }
            const target = isRedirect(verdict) ? verdict : { to: verdict as NavigateTarget, replace: true };
            finish();
            untrack(() => performNavigate(target.to, { replace: target.replace }));
            return false;
        };
        const settleThrow = (error: unknown): void =>
        {
            if (isRedirect(error))
            {
                applyVerdict(error);
                return;
            }
            // A throwing guard fails CLOSED: the guarded route must not render. Deliberately
            // NOT dev-gated: the exception is swallowed here, and a production navigation
            // silently going nowhere needs its one signal.
            console.error('[azerothjs/router] a route guard threw; navigation vetoed.', error);
            veto();
        };

        if (m === null)
        {
            accept(null);
            return;
        }

        const context: GuardContext = {
            params: m.params,
            pathname: m.pathname,
            query: parseQuery(s.search),
            from: lastAcceptedLocation
        };
        const proceed = (index: number): void =>
        {
            for (let i = index; i < m.matched.length; i++)
            {
                const guardFn = m.matched[i]?.guard;
                if (guardFn === undefined)
                {
                    continue;
                }
                let verdict: unknown;
                try
                {
                    verdict = guardFn(context);
                }
                catch (error)
                {
                    settleThrow(error);
                    return;
                }
                if (typeof (verdict as PromiseLike<unknown> | null)?.then === 'function')
                {
                    // Async guard: the navigation HOLDS (pending() true) until it settles;
                    // a newer navigation supersedes this run entirely.
                    setGuarding(true);
                    void Promise.resolve(verdict as PromiseLike<unknown>).then(
                        (resolved) =>
                        {
                            if (run === guardRun && applyVerdict(resolved))
                            {
                                proceed(i + 1);
                            }
                        },
                        (error: unknown) =>
                        {
                            if (run === guardRun)
                            {
                                settleThrow(error);
                            }
                        }
                    );
                    return;
                }
                if (!applyVerdict(verdict))
                {
                    return;
                }
            }
            accept(m);
        };
        proceed(0);
    });

    // SSR: effects never run in string mode, so the guarded-match pipeline above
    // stays silent and <Routes> would serialize the fallback for EVERY url. Guards
    // gate NAVIGATION; by the time a server renders, the request was already routed
    // and authorized - matchAndLoad runs the chain's guards server-side and turns a
    // redirecting/vetoing guard into a real 302/skip BEFORE any rendering starts.
    // The string render is a pure serializer of that decision: accept the raw match
    // synchronously and do not re-run guards (an async guard could never settle
    // inside a synchronous render anyway).
    if (isStringMode())
    {
        setMatch(untrack(rawMatch));
    }

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

    // A loader that THREW redirect(...) is a navigation instruction, not an error:
    // perform it (replace by default - the interrupted entry must not survive).
    createEffect(() =>
    {
        for (const resource of loaders)
        {
            const error = resource.error();
            if (isRedirect(error))
            {
                untrack(() => performNavigate(error.to, { replace: error.replace }));
                return;
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
        !chainReady() || guarding() || loaders.some((resource) => resource.loading()));

    // MANAGED SCROLLING (browser only; config scroll !== false). Positions are
    // recorded per entry KEY the moment we leave an entry - commitNavigate and the
    // pop path both call recordScroll() BEFORE the URL moves - and applied one
    // microtask after the location lands (the same flush <Routes> swapped in, so
    // the new DOM is in place). A per-navigation `scroll` option overrides.
    // scrollManaged / scrollPositions / navScrollOverride are declared above the guard
    // effect (a boot-time guard redirect reaches them synchronously); recordScroll and the
    // scroll effect below close over those same bindings.
    function recordScroll(): void
    {
        if (scrollManaged)
        {
            scrollPositions.set(currentKey, { x: window.scrollX, y: window.scrollY });
        }
    }
    if (scrollManaged)
    {
        let appliedKey = untrack(location).key;
        createEffect(() =>
        {
            const l = location();
            if (l.key === appliedKey)
            {
                return;
            }
            appliedKey = l.key;
            const override = navScrollOverride;
            navScrollOverride = undefined;
            queueMicrotask(() =>
            {
                if (override === false)
                {
                    return;
                }
                if (override === true)
                {
                    window.scrollTo({ top: 0, left: 0 });
                    return;
                }
                const saved = scrollPositions.get(l.key) ?? null;
                if (config.scrollBehavior !== undefined)
                {
                    const target = config.scrollBehavior({ location: l, saved });
                    if (target !== false)
                    {
                        window.scrollTo({ left: target.x, top: target.y });
                    }
                    return;
                }
                if (l.navigationKind === 'pop' && saved !== null)
                {
                    window.scrollTo({ left: saved.x, top: saved.y });
                    return;
                }
                if (l.hash.length > 1)
                {
                    const anchor = document.getElementById(l.hash.slice(1));
                    if (anchor !== null)
                    {
                        anchor.scrollIntoView();
                        return;
                    }
                }
                window.scrollTo({ top: 0, left: 0 });
            });
        });
    }

    // `blockers` (the router.block() leave-guards set) is declared above the guard effect;
    // performNavigate reads it on a boot-time guard redirect.

    function performNavigate(target: NavigateTarget, options: NavigateOptions): void
    {
        if (blockers.size > 0)
        {
            const context = {
                from: untrack(location),
                to: target,
                kind: (options.replace === true ? 'replace' : 'push') as NavigationKind
            };
            const verdicts = [...blockers].map((blocker) => blocker(context));
            if (verdicts.some((verdict) => verdict === false))
            {
                return;
            }
            const holds = verdicts.filter((verdict): verdict is Promise<boolean> => typeof verdict === 'object');
            if (holds.length > 0)
            {
                // Async blockers HOLD the navigation; it commits only if every one allows.
                void Promise.all(holds).then((resolved) =>
                {
                    if (resolved.every((allowed) => allowed))
                    {
                        commitNavigate(target, options);
                    }
                });
                return;
            }
        }
        commitNavigate(target, options);
    }

    function commitNavigate(target: NavigateTarget, options: NavigateOptions): void
    {
        recordScroll();
        navScrollOverride = options.scroll;

        // resolve() applies the base prefix (internal targets only), so history
        // always holds the real browser URL.
        const fullPath = resolve(target);

        // Every router-written entry is STAMPED: a fresh key, and an index one
        // past the current entry for a push (a replace keeps the index). The
        // user's own state rides beside the stamp.
        const stamped: StampedState = {
            __az: { key: freshKey(), index: options.replace ? currentIndex : currentIndex + 1 },
            state: options.state
        };
        currentIndex = stamped.__az.index;
        currentKey = stamped.__az.key;

        pendingKind = options.replace ? 'replace' : 'push';
        if (options.replace)
        {
            history.replace(fullPath, stamped);
        }
        else
        {
            history.push(fullPath, stamped);
        }
        pendingKind = null;
    }

    return {
        location,
        match,
        loaders,
        pending,
        chainReady,
        focusManagement: config.focus !== false,
        block(blocker): () => void
        {
            blockers.add(blocker);
            return (): void =>
            {
                blockers.delete(blocker);
            };
        },
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
