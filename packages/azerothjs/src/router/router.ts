/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * createRouter is the orchestrator. Every other router export is a thin reactive layer over
 * the Router it returns.
 *
 * The flow is one-way: navigate() pushes or replaces on the HistoryAdapter, the adapter's
 * subscription updates a single internal state signal, and the `location` and `match` memos
 * derive from that. A URL is therefore matched once per change, and every downstream read is
 * a near-free structural read.
 *
 * The history subscription is registered with the surrounding scope, so it - and, if it was
 * the last subscriber, the native popstate listener - is torn down on unmount. createRouter
 * MUST therefore run inside a root: render() wraps the tree in one, so a top-level component
 * is covered, but standalone use in a test has to wrap it explicitly.
 *
 * At construction the route tree is flattened to one entry per leaf, each a compiled
 * full-path matcher plus the root-to-leaf chain Outlet needs. Matching is a linear first-hit
 * scan, so configuration order defines priority, as it does in every other router on the web.
 */

import type { Getter, Resource } from '../reactivity/index.ts';
import {
    createSignal,
    createMemo,
    createEffect,
    createResource,
    createRoot,
    getOwner,
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
import { compilePath, paramNamesOf, type PathMatcher } from './path-pattern.ts';
import type { CacheEntry, DataCache, FamilyRecord } from '../reactivity/data-cache.ts';
import { CACHED_FAMILY, entryKeyFor, getDataCache, readValue, stableSerialize } from '../reactivity/data-cache.ts';
import { DEV } from '../reactivity/dev.ts';
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

/** Distinguishes each router's loader family; the position-keyed entries never cross routers. */
let routerSerial = 0;

/** DEV-only: routes already given the declare-a-search-schema hint. */
const queryHinted = new WeakSet<Route>();

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
        // A failed chunk load is NOT poisoned for the process: drop the failure and retry
        // below. componentOf keeps throwing the recorded error until a retry succeeds.
        LAZY_CACHE.delete(route);
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
     * Marks every loader entry of the current location stale and refetches the
     * watched ones, resolving when those refetches settle. The one call a
     * mutation needs after changing what the page's loaders would return.
     */
    revalidate: () => Promise<void>;

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
 * Builds a {@link Router} from a route config: the reactive `location`, `match` and `loader`,
 * plus the imperative navigate, replace, back, forward and href.
 *
 * MUST be created inside a root, or the history subscription and the native popstate listener
 * leak. render() provides one, so a top-level component is covered; a test has to wrap it.
 *
 * Route ORDER is priority - the first matching leaf wins - so put specific routes before
 * catch-alls.
 *
 * The URL is matched once per change and `match` compares structurally, so a cosmetic change
 * such as a new hash does not invalidate anything downstream. The loader is a resource keyed
 * on the match, which is where its cancellation and race guard come from for free. A `base`
 * is prefixed on write and stripped on read, so routes, params and `<Link to>` all stay
 * base-relative; a URL outside the configured base simply does not match, though `location`
 * still reflects the raw pathname.
 *
 * navigate runs untracked, so calling it inside an effect adds no subscriptions.
 *
 * @param config - Routes, and optionally `base`, `history` and `mode`.
 * @returns The {@link Router}. It cleans up when the surrounding root disposes.
 * @example
 * const router = createRouter({
 *     routes: [
 *         { path: '/', component: Home },
 *         { path: '/users/:id', component: UserPage }
 *     ]
 * });
 *
 * router.navigate('/users/42');
 * router.location().params.id; // '42'
 *
 * @see {@link Link} and {@link Routes}, which read the router this returns.
 */
export function createRouter(config: RouterConfig): Router
{
    // A router built OUTSIDE any ownership scope (module scope, an app-lifetime
    // singleton - a documented shell shape) gets its own root, exactly as createStore
    // gives its factory one: the internal effects need an owner to register against,
    // and an app-lifetime router's disposer is deliberately dropped because the state
    // is meant to outlive every mount. Under an ambient owner nothing changes - a
    // component-scoped router still disposes with its component.
    if (getOwner() === null)
    {
        let built!: Router;
        createRoot(() =>
        {
            built = buildRouter(config);
        });
        return built;
    }
    return buildRouter(config);
}

/** @internal The construction body; runs under whichever owner createRouter resolved. */
function buildRouter(config: RouterConfig): Router
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

    /**
     * Everything one level's loader run needs, staged by the level's KEY MEMO the moment it
     * computes the key. The fetcher reads the CURRENTLY staged record for its key - same
     * key, same declared inputs, so re-staging is idempotent and a re-run for a non-query
     * reason receives current values.
     *
     * @internal
     */
    interface StagedTrigger
    {
        level: number;
        loader: (args: RouteLoaderArgs) => Promise<unknown>;
        params: Params;
        query: Query;
        parentKey: string | null;
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
        // The CHAIN, not the leaf. One route config reused under two parents occupies two
        // POSITIONS that share a leaf object, so comparing the leaf alone reports them equal:
        // the memo never updates, the previous position keeps rendering, and its guards are
        // never re-entered - wrong-route data and an authorization bypass at once. The leaf is
        // the chain's last element, so comparing the chain subsumes comparing it.
        if (a.matched.length !== b.matched.length)
        {
            return false;
        }
        for (let level = 0; level < a.matched.length; level++)
        {
            if (a.matched[level] !== b.matched[level])
            {
                return false;
            }
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

    // A user-facing snapshot. Re-derives only when state changes. `params` come from the
    // GUARDED match (declared below; the memo body runs lazily, after it exists): params
    // are MATCH OUTPUT - the thing guards gate - not URL truth, so a pending navigation's
    // params must not surface through live components while the old chain is still
    // rendered. pathname/search/hash stay raw URL truth, so
    // during an async guard hold the pathname may briefly LEAD the params.
    const location = createMemo<RouteLocation>(() =>
    {
        const s = state();
        return {
            pathname: s.pathname,
            search: s.search,
            hash: s.hash,
            params: match()?.params ?? {},
            query: parseQuery(s.search),
            fullPath: s.fullPath,
            navigationKind: s.kind,
            delta: s.delta,
            key: s.key
        };
    });
    let guardRun = 0;
    // BASE-RELATIVE, like every other path the router holds internally. It is fed straight back
    // to performNavigate on a veto, and commitNavigate -> resolve() applies the base prefix
    // itself - storing it pre-prefixed made a veto under base '/app' write '/app/app/other'
    // into history, and the router then read that back as the base-relative '/app/other'.
    let lastAcceptedPath: string | null = null;
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
            lastAcceptedPath = s.fullPath;
            // Composed from the ACCEPTED match directly rather than read from location():
            // location's params now derive from the guarded match, which at this point
            // still holds the PREVIOUS navigation - reading it here would pair the
            // accepted target's pathname with stale params, and that snapshot is exactly
            // what the NEXT navigation's GuardContext.from receives (the one pipeline
            // carve-out, pinned by the from-params spec).
            lastAcceptedLocation = {
                pathname: s.pathname,
                search: s.search,
                hash: s.hash,
                params: value?.params ?? {},
                query: parseQuery(s.search),
                fullPath: s.fullPath,
                navigationKind: s.kind,
                delta: s.delta,
                key: s.key
            };
            setMatch(value);
        };
        const veto = (): void =>
        {
            finish();
            if (lastAcceptedPath !== null)
            {
                // Restore the previous URL in place: the vetoed entry never renders and
                // does not survive on the stack. The restored route's guards re-run and
                // pass again (they passed before) - guards must be side-effect-free.
                untrack(() => performNavigate(lastAcceptedPath as string, { replace: true }));
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
        && seed.version === 3
        && Array.isArray(seed.data)
        && seed.path === initialState.pathname + initialState.search;

    // The raw search string, isolated so loaders can depend on it WITHOUT depending on the
    // whole location. `match` is deliberately query-blind (a structural memo over the matched
    // chain), so a source that read only match never re-evaluated for `?q=a` -> `?q=b` and the
    // loader never re-ran - even though `query` is part of its documented arguments. Reading
    // state() directly instead would re-run loaders on hash-only changes too; a memo over the
    // string collapses those, because equal strings do not propagate.
    const searchString = createMemo(() => state().search);

    // The commit point for EVERY navigation shape - match changes, query-only, hash-only
    // (harmless): fetches begun from here on belong to THIS navigation and are never
    // no-op'd as stale by a concurrent revalidate. Guard-accept alone would miss the
    // query-only commits its structural match equality collapses.
    createEffect(() =>
    {
        state();
        getDataCache()?.beginNavigation();
    });

    // --- loader identity ----------------------------------------------------------------
    // Every POSITION in the tree gets an id - the chain PREFIX, not the config object, and not
    // the joined pattern (which collides across same-path sibling layouts). A config object
    // reused under two parents occupies TWO positions and must key separately, while two
    // sibling leaves still SHARE their layout's id because they share every prefix above
    // themselves. A level's cache key is that position id +
    // the PREFIX params slice (params bound by levels 0..N - never a descendant's, which is
    // what confined a leaf navigation's refetch to the leaf) + the search component: a
    // route WITH a `search` schema keys on the serialized parse output (declared subset,
    // defaults and coercions normalized, invalid degrades to {}), a route WITHOUT one keys
    // on the full search string - schema-less routes keep refetching on any query change.
    const positionIds = new WeakMap<Route[], number[]>();
    {
        let nextId = 0;
        interface PositionNode { id: number; below: Map<Route, PositionNode> }
        const top = new Map<Route, PositionNode>();
        for (const entry of leaves)
        {
            const ids: number[] = [];
            let level = top;
            for (const route of entry.matched)
            {
                let node = level.get(route);
                if (node === undefined)
                {
                    node = { id: nextId, below: new Map() };
                    nextId += 1;
                    level.set(route, node);
                }
                ids.push(node.id);
                level = node.below;
            }
            // Keyed on the chain ARRAY, which is the very array the match carries
            // (`matched: entry.matched` above), so a key lookup is one WeakMap read plus an
            // index rather than a walk down the tree on every level of every navigation.
            positionIds.set(entry.matched, ids);
        }
    }

    /** The declared query a level's loader receives and its key serializes: parsed through
     * the route's schema when one exists (so key and arguments can never skew), the full
     * parsed query otherwise. */
    function levelQuery(route: Route, search: string): Query
    {
        const query = parseQuery(search);
        if (route.search === undefined)
        {
            // DEV hint, once per route: a schema-less loader touching `query` refetches on
            // EVERY query change; declaring a `search` schema confines it to the declared
            // subset. An optimization pointer, not a correctness warning.
            if (DEV && route.loader !== undefined && !queryHinted.has(route))
            {
                return new Proxy(query, {
                    get: (target, property, receiver): unknown =>
                    {
                        if (!queryHinted.has(route))
                        {
                            queryHinted.add(route);
                            console.info(`[azerothjs/router] the loader for "${ route.path }" reads query without a `
                                + 'search schema, so ANY query change refetches it; declare `search` to key on the fields it uses.');
                        }
                        return Reflect.get(target, property, receiver);
                    }
                });
            }
            return query;
        }
        const parsed = route.search.safeParse(query);
        return (parsed.ok ? parsed.value : {}) as Query;
    }

    function levelKeyFor(m: RouteMatch | null, search: string, level: number): string | null
    {
        const route = m?.matched[level];
        if (m === null || route === undefined || !route.loader)
        {
            return null;
        }
        const prefix: Params = {};
        for (let i = 0; i <= level; i++)
        {
            const above = m.matched[i];
            if (above === undefined)
            {
                continue;
            }
            for (const name of paramNamesOf(above.path))
            {
                const value = m.params[name];
                if (value !== undefined)
                {
                    prefix[name] = value;
                }
            }
        }
        const searchComponent = route.search === undefined ? search : levelQuery(route, search);
        return `${ positionIds.get(m.matched)?.[level] ?? -1 }#${ level }|${ stableSerialize(prefix) }|${ stableSerialize(searchComponent) }`;
    }

    /** The nearest ancestor level WITH a loader, as a key, or null at the root. */
    function parentKeyFor(m: RouteMatch, search: string, level: number): string | null
    {
        for (let above = level - 1; above >= 0; above--)
        {
            const key = levelKeyFor(m, search, above);
            if (key !== null)
            {
                return key;
            }
        }
        return null;
    }

    // One loader FAMILY per router: entries are keyed by the level key, fetched by reading
    // the staged trigger back. The family record is branded straight onto the fetcher so
    // createResource takes the shared-entry path.
    routerSerial += 1;
    const stagedTriggers = new Map<string, StagedTrigger>();
    const loaderFamily: FamilyRecord = {
        name: `azeroth.loader#${ routerSerial }`,
        fetcher: (async (key: string, signal: AbortSignal): Promise<unknown> =>
        {
            const trigger = stagedTriggers.get(key);
            if (trigger === undefined)
            {
                throw new Error('[azerothjs/router] internal: a loader fetch ran for a key that was never staged.');
            }
            const cache = getDataCache();
            const selfEntry = cache?.peek(loaderFamily, [key]);
            if (selfEntry !== undefined)
            {
                // The propagation scan compares ENTRY keys, so the stamp must be the parent
                // entry's full key, not the raw level key it wraps.
                selfEntry.parentKey = trigger.parentKey === null
                    ? null
                    : entryKeyFor(loaderFamily, [trigger.parentKey]);
                selfEntry.usedParent = false; // last-run truth; awaiting parent re-records it
            }
            const parent = parentPromiseFor(cache ?? null, trigger.parentKey, selfEntry);
            return trigger.loader({ params: trigger.params, query: trigger.query, signal, parent });
        }) as FamilyRecord['fetcher'],
        fresh: 0,
        retain: 5 * 60 * 1000
    };
    const brandedLoaderFetcher = Object.assign(
        (key: string, signal: AbortSignal) => (loaderFamily.fetcher as (k: string, s: AbortSignal) => Promise<unknown>)(key, signal),
        { [CACHED_FAMILY]: loaderFamily }
    );

    /**
     * `args.parent` over the parent level's ENTRY - a partition: in-flight awaits its
     * settlement; a VALUED idle parent (fresh, stale, or errored) delivers its retained
     * value; an absent or valueless parent is read through the registry, which starts its
     * fetch. Lazily resolved through a thenable so awaiting it is what records the
     * parent-child dependency edge.
     */
    function parentPromiseFor(cache: DataCache | null, parentKey: string | null, childEntry: CacheEntry | undefined): Promise<unknown>
    {
        const resolveParent = (): Promise<unknown> =>
        {
            if (parentKey === null || cache === null)
            {
                return Promise.resolve(undefined);
            }
            const parentEntry = cache.peek(loaderFamily, [parentKey]);
            if (parentEntry === undefined || (parentEntry.inflight === null && !parentEntry.hasValue))
            {
                return readValue(cache, loaderFamily, [parentKey]);
            }
            if (parentEntry.inflight !== null)
            {
                // The awaiting child is an audience: the waiter keeps a zero-subscriber
                // parent's fetch from aborting under it mid-settlement.
                cache.holdWaiter(parentEntry);
                return cache.settlementFor(parentEntry, parentEntry.inflight.startedSeq).then(() =>
                {
                    if (parentEntry.hasError && !parentEntry.hasValue)
                    {
                        throw parentEntry.error;
                    }
                    return parentEntry.value;
                }).finally(() =>
                {
                    cache.releaseWaiter(parentEntry);
                });
            }
            return Promise.resolve(parentEntry.value);
        };
        let inner: Promise<unknown> | null = null;
        const thenable = {
            then<TOk, TErr>(onOk?: (value: unknown) => TOk, onErr?: (reason: unknown) => TErr): Promise<TOk | TErr>
            {
                if (childEntry !== undefined)
                {
                    childEntry.usedParent = true;
                }
                inner ??= resolveParent();
                return inner.then(onOk, onErr);
            },
            catch(onErr?: (reason: unknown) => unknown): Promise<unknown>
            {
                return thenable.then(undefined, onErr);
            },
            finally(onFinally?: () => void): Promise<unknown>
            {
                return thenable.then(
                    (value) =>
                    {
                        onFinally?.();
                        return value;
                    },
                    (reason: unknown) =>
                    {
                        onFinally?.();
                        throw reason;
                    }
                );
            }
        };
        return thenable as unknown as Promise<unknown>;
    }

    // v3 seed adoption writes ENTRIES before the level resources exist, so the data is
    // shared state from the first paint: subscription-fresh for a fresh seed; STALE-marked
    // with a deferred heal for one older than the adoption bound (a page cache served it
    // stale - the client revalidates once after hydration instead of pinning that age in).
    const SEED_FRESH_MS = 30_000;
    if (adopt)
    {
        const cache = getDataCache();
        const m0 = untrack(rawMatch);
        if (cache !== null && m0 !== null)
        {
            for (let level = 0; level < seed.data.length; level++)
            {
                if (seed.data[level] === undefined)
                {
                    continue;
                }
                const key = levelKeyFor(m0, initialState.search, level);
                if (key === null)
                {
                    continue;
                }
                stagedTriggers.set(key, {
                    level,
                    loader: (m0.matched[level] as Route & { loader: NonNullable<Route['loader']> }).loader,
                    params: m0.params,
                    query: levelQuery(m0.matched[level] as Route, initialState.search),
                    parentKey: parentKeyFor(m0, initialState.search, level)
                });
                const entry = cache.entryFor(loaderFamily, [key]);
                if (!entry.hasValue)
                {
                    cache.writeEntry(entry, seed.data[level]);
                    // The parent edge exists BEFORE any client run: a seeded chain whose
                    // parent renews must reach its seeded children, so the edge is stamped
                    // conservatively (usedParent true - the worst case is one refetch that
                    // reads the fresh parent, never a child left deriving from the old one).
                    const parentLevelKey = parentKeyFor(m0, initialState.search, level);
                    entry.parentKey = parentLevelKey === null ? null : entryKeyFor(loaderFamily, [parentLevelKey]);
                    entry.usedParent = entry.parentKey !== null;
                    if (seed.build !== undefined)
                    {
                        entry.build = seed.build;
                    }
                    if (seed.at !== undefined)
                    {
                        entry.seededAt = seed.at;
                    }
                    const at = seed.static === true ? undefined : seed.at;
                    if (at !== undefined)
                    {
                        entry.writtenAt = at;
                        const age = Date.now() - at;
                        if (age > SEED_FRESH_MS)
                        {
                            // After the synchronous hydration pass: the level resource has
                            // subscribed by then, so the heal refetches exactly once.
                            queueMicrotask(() =>
                            {
                                void cache.revalidateEntry(entry);
                            });
                        }
                    }
                }
            }
        }
    }

    // One resource per level, keyed by the level's KEY STRING with string equality: a
    // navigation that leaves a level's key unchanged (a leaf param change, an undeclared
    // query change) does not re-run it - the blast-radius fix. Computing the key stages
    // the trigger; the branded fetcher reads it back, so all levels with changed keys
    // still start IN PARALLEL by construction.
    const loaders: Array<Resource<unknown>> = [];
    for (let level = 0; level < maxDepth; level++)
    {
        loaders.push(createResource<unknown, string>(
            () =>
            {
                const m = match();
                const search = searchString();
                const key = levelKeyFor(m, search, level);
                if (key !== null && m !== null)
                {
                    const route = m.matched[level] as Route & { loader: NonNullable<Route['loader']> };
                    stagedTriggers.set(key, {
                        level,
                        loader: route.loader,
                        params: m.params,
                        query: levelQuery(route, search),
                        parentKey: parentKeyFor(m, search, level)
                    });
                }
                return key;
            },
            brandedLoaderFetcher,
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
            const chunk = LAZY_CACHE.get(route);
            // A recorded FAILURE retries on the next demand instead of poisoning the route
            // for the process - resolveRouteComponent drops it and re-runs the import.
            if (route.lazy !== undefined && (chunk === undefined || 'error' in chunk))
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
        revalidate(): Promise<void>
        {
            const cache = getDataCache();
            if (cache === null)
            {
                return Promise.resolve();
            }
            const m = untrack(match);
            const search = untrack(searchString);
            const settlements: Promise<void>[] = [];
            for (let level = 0; level < maxDepth; level++)
            {
                const key = levelKeyFor(m, search, level);
                if (key === null)
                {
                    continue;
                }
                const entry = cache.peek(loaderFamily, [key]);
                if (entry !== undefined)
                {
                    settlements.push(cache.revalidateEntry(entry));
                }
            }
            return Promise.all(settlements).then(() => undefined);
        },
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
