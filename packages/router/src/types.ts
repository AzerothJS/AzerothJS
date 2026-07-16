/**
 * MODULE: router/types
 *
 * Shared router type contracts. Component-specific prop types (LinkProps, RoutesProps, OutletProps)
 * live with their components; the Router object's shape lives next to createRouter.
 *
 * MENTAL MODEL: the browser URL is the source of truth. The HistoryAdapter wraps it so changes can
 * be subscribed to; the router parses each URL into a RouteLocation snapshot exposed as a reactive
 * signal, and composables (useParams, useQuery) derive narrower memos from it.
 */

import type { MountNode } from '@azerothjs/component';

/**
 * Path parameters extracted from a URL.
 *
 * Each segment in a route pattern that starts with a colon
 * (`/users/:id`) becomes a key in this object. Wildcard segments
 * (`/docs/*path`) also write here.
 *
 * Values are always strings; the matcher does not coerce types. Use
 * `Number(params.id)` if you need a number.
 *
 * @example
 * ```ts
 * // Pattern: /users/:id/posts/:slug
 * // URL:     /users/42/posts/hello-world
 * // params:  { id: '42', slug: 'hello-world' }
 * ```
 */
export type Params = Record<string, string>;

/**
 * Parsed query string.
 *
 * Single values are strings. Repeated keys (`?tags=a&tags=b`) produce a string
 * array. Empty values are kept as empty strings, not dropped: `?flag=` becomes
 * `{ flag: '' }`.
 *
 * @example
 * ```ts
 * // ?page=2&sort=desc  -> { page: '2', sort: 'desc' }
 * // ?tags=a&tags=b     -> { tags: ['a', 'b'] }
 * // ?flag              -> { flag: '' }
 * ```
 */
export type Query = Record<string, string | string[]>;

/**
 * A snapshot of "where the user currently is" in the app.
 *
 * Returned by `useRoute()` and exposed as the value of the router's `location`
 * signal. Read-only; to navigate, use `navigate()` from the router.
 *
 * Field names follow the browser `URL` API where possible (`pathname`,
 * `search`, `hash`) so the mental mapping is obvious.
 */
export interface RouteLocation
{
    /** The path portion of the URL, e.g. `/users/42`. No query, no hash. */
    pathname: string;

    /** Raw query string including the leading `?`, e.g. `?page=2`. Empty string if absent. */
    search: string;

    /** Raw hash including the leading `#`, e.g. `#section-2`. Empty string if absent. */
    hash: string;

    /** Path params parsed from the matched route pattern. Empty object if no match. */
    params: Params;

    /** Parsed query string. Empty object if absent. */
    query: Query;

    /** `pathname + search + hash`: the value you'd put in a `<Link href>`. */
    fullPath: string;
}

/**
 * The component shape used by routes.
 *
 * Layout components (routes that have `children`) receive `children` containing
 * the next nested level's rendered output; leaf components ignore it. By default
 * the router passes `{}`, so a leaf component can declare `() => h('div', ...)`
 * with no argument and TypeScript stays happy.
 *
 * @example
 * ```ts
 * // Layout: renders children somewhere
 * const AppLayout: RouteComponent = ({ children }) =>
 *     h('div', { class: 'app' },
 *         h('header', {}, 'My App'),
 *         h('main', {}, children)
 *     );
 *
 * // Leaf: no children needed
 * const Home: RouteComponent = () =>
 *     h('h1', {}, 'Welcome');
 * ```
 */
export type RouteComponent = (props: { children?: MountNode | undefined }) => MountNode;

/**
 * A route definition.
 *
 * Passed to `createRouter({ routes: [...] })`. Routes can nest:
 * a route with `children` becomes a layout that wraps its
 * children's rendered output via `<Outlet>`.
 *
 * @example
 * ```ts
 * const routes: Route[] =
 * [
 *     { path: '/', component: Home },
 *     {
 *         path: '/users',
 *         component: UsersLayout,
 *         children:
 *         [
 *             { path: '', component: UserList },           // /users
 *             { path: ':id', component: UserProfile }      // /users/:id
 *         ]
 *     }
 * ];
 * ```
 */
export interface Route
{
    /**
     * The path pattern relative to the parent route.
     *
     * Top-level routes are absolute (start with `/`); nested routes are
     * relative to their parent (no leading `/`). An empty string `''` matches
     * the parent path exactly (the index route).
     *
     * Supported syntax:
     *   - Static segments: `/users`
     *   - Param segments: `/:id`, `/:slug`
     *   - Wildcard segments: `/*rest` (matches the rest of the path)
     */
    path: string;

    /** Component to render when this route matches. */
    component: RouteComponent;

    /** Optional nested routes, matched against the unmatched suffix. */
    children?: Route[];

    /** Optional name for programmatic navigation by reference. */
    name?: string;

    /** Free-form metadata, kept verbatim and made available on the match. */
    meta?: Record<string, unknown>;

    /**
     * Optional async loader. Runs when this route matches; the result is
     * exposed via `useLoader(router)` inside the route's component tree.
     * Powered by `createResource`: re-runs when params change, aborts on
     * navigation away.
     *
     * The arg is bundled into an object so future fields (location, query,
     * parent-loader data) can be added without a breaking signature change.
     *
     * @example
     * ```ts
     * {
     *     path: '/users/:id',
     *     component: UserPage,
     *     loader: async ({ params, signal }) =>
     *     {
     *         const res = await fetch(`/api/users/${ params.id }`, { signal });
     *         if (!res.ok) throw new Error(res.statusText);
     *         return res.json();
     *     }
     * }
     * ```
     */
    loader?: (args: { params: Params; signal: AbortSignal }) => Promise<unknown>;
}

/**
 * The result of matching a URL against the route tree.
 *
 * `matched` is the chain from root to leaf; `<Outlet>` walks it so each layout
 * renders the next step.
 *
 * Internal-leaning, but exported so advanced users (route guards, tooling) can
 * inspect what matched.
 */
export interface RouteMatch
{
    /** The leaf route that matched (deepest level). */
    route: Route;

    /** All path params from the full chain, merged into one object. */
    params: Params;

    /** Root-to-leaf chain of every route that matched along the way. */
    matched: Route[];

    /** The URL pathname that produced this match. */
    pathname: string;
}

/**
 * What you can pass as the destination of `navigate()`.
 *
 * A plain string is treated as a `fullPath` (pathname plus optional search and
 * hash). The structured form is convenient when building URLs from data: the
 * router handles encoding.
 *
 * @example
 * ```ts
 * navigate('/users/42');
 * navigate('/users/42?tab=posts#bio');
 *
 * navigate({ pathname: '/users/42', query: { tab: 'posts' }, hash: '#bio' });
 * ```
 */
export type NavigateTarget =
    | string
    | {
        pathname: string;
        query?: Query;
        hash?: string;
    };

/**
 * Options that modify how a navigation behaves.
 */
export interface NavigateOptions
{
    /**
     * If `true`, replace the current history entry instead of pushing a new
     * one. The Back button will skip over this navigation. Default: `false`.
     */
    replace?: boolean;

    /**
     * Optional state to attach to the history entry, retrievable
     * via `history.state` after navigation. Default: `undefined`.
     */
    state?: unknown;

    /**
     * If `true`, scroll the page to top after navigation. The router does not
     * scroll automatically by default; set this to opt in for individual
     * navigations, or wire your own scroll-restoration logic via the location
     * signal. Default: `false`.
     */
    scroll?: boolean | undefined;
}

/**
 * Routing strategy.
 *
 * For v1 only `'history'` is implemented (HTML5 History API: `pushState` +
 * `popstate`). The union is open so adding `'hash'` or `'memory'` later is a
 * non-breaking change.
 */
export type RouterMode = 'history';

/**
 * Configuration passed to `createRouter()`.
 */
export interface RouterConfig
{
    /** Top-level route list. Required. */
    routes: Route[];

    /**
     * Optional base path. All route paths are matched relative to
     * this base, and all generated URLs are prefixed with it.
     * Useful when the app is served under a sub-path (`/app`).
     * Must start with `/`. Default: `'/'`.
     */
    base?: string | undefined;

    /** Routing strategy. Default: `'history'`. */
    mode?: RouterMode;

    /**
     * History adapter the router reads/writes the URL through. Defaults to
     * `createBrowserHistory()` (window-backed). Inject `createMemoryHistory(url)`
     * for SSR (one adapter per request, no `window`) or for tests.
     */
    history?: HistoryAdapter;

    /**
     * Server-loaded data adopted for the INITIAL location (the SSR/hydration handoff).
     * On the server: pass what `matchAndLoad` returned so the render sees loader data
     * synchronously. On the client: pass `readLoaderHandoff()` so hydration does not
     * refetch what the server just loaded. Ignored (a normal fetch runs) unless `path`
     * exactly equals the initial pathname + search.
     */
    initialLoaderData?: LoaderHandoff | undefined;
}

/** One route's server-loaded output, keyed by the exact URL it was loaded for. */
export interface LoaderHandoff
{
    /** The base-relative pathname + search the data belongs to. */
    path: string;

    /** Whatever the matched route's loader returned (must be JSON-serializable to cross the wire). */
    data: unknown;
}

/**
 * The history abstraction the router uses to read and update the URL.
 *
 * Browsers get the History API implementation, tests get an in-memory one, and
 * SSR gets a request-bound one. The router itself stays oblivious to which it's
 * talking to.
 */
export interface HistoryAdapter
{
    /**
     * The current URL as a `fullPath` (pathname + search + hash).
     *
     * Always reflects the current state; the adapter never lags behind the
     * underlying source.
     */
    current(): string;

    /**
     * Navigate to a new URL, pushing a new history entry.
     *
     * @param fullPath - pathname + optional search + optional hash
     * @param state - optional state to attach to the history entry
     */
    push(fullPath: string, state?: unknown): void;

    /**
     * Navigate to a new URL, replacing the current history entry.
     *
     * @param fullPath - pathname + optional search + optional hash
     * @param state - optional state to attach to the history entry
     */
    replace(fullPath: string, state?: unknown): void;

    /** Go back one history entry, equivalent to the browser's Back button. */
    back(): void;

    /** Go forward one history entry, equivalent to the browser's Forward button. */
    forward(): void;

    /**
     * Subscribe to URL changes from the underlying source
     * (e.g., browser popstate, in-memory dispatch).
     *
     * The callback receives the new full path. Returns an unsubscribe
     * function; call it to detach the listener.
     */
    subscribe(listener: (fullPath: string) => void): () => void;
}
