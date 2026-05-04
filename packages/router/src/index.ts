// ============================================================================
// AZEROTHJS — Router Public API
// ============================================================================
//
// Manual-first router — explicit `Router` instance, `<Link>` /
// `<Routes>` / `<Outlet>` components, and the `useRoute` /
// `useParams` / `useQuery` / `useNavigate` composables. File-based
// routing layers on top of this in a later step.
//
// EXPORTED (public):
//
//   Constructor + helpers
//     createRouter()        — Build a Router from a route list
//     createBrowserHistory()— Build a HistoryAdapter for the browser
//     compilePath()         — Compile a path pattern (advanced)
//     parseQuery()          — URL query → object (advanced)
//     stringifyQuery()      — Object → URL query (advanced)
//     targetToFullPath()    — NavigateTarget → fullPath string
//
//   Components
//     Link                  — SPA-aware <a>
//     Routes                — Renders the matched route chain
//     Outlet                — Where a layout puts its children
//
//   Composables
//     useRoute(router)      — Reactive RouteLocation
//     useMatch(router)      — Reactive RouteMatch | null
//     useParams(router)     — Slice-memoized params
//     useQuery(router)      — Slice-memoized query
//     useNavigate(router)   — Imperative navigation API
//     useLoader(router)     — Resource holding loader output
//
//   Types
//     Router, RouteLocation, RouteComponent, Route, RouteMatch,
//     Params, Query, NavigateTarget, NavigateOptions, RouterMode,
//     RouterConfig, HistoryAdapter, PathMatcher, LinkProps,
//     RoutesProps, OutletProps, NavigateApi
//
// NOT EXPORTED (internal):
//
//   joinPaths, flattenRoutes, splitFullPath, shallowEqualParams,
//   shallowEqualRecord — implementation details inside their files.
//
// ============================================================================

// ── Functions ────────────────────────────────────────────────

export { createRouter, targetToFullPath } from './router.ts';
export { createBrowserHistory } from './history.ts';
export { compilePath } from './path-pattern.ts';
export { parseQuery, stringifyQuery } from './query.ts';

// ── Components ───────────────────────────────────────────────

export { Link } from './link.ts';
export { Routes } from './routes.ts';
export { Outlet } from './outlet.ts';

// ── Composables ──────────────────────────────────────────────

export {
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate
} from './use-route.ts';
export { useLoader } from './use-loader.ts';

// ── Types ────────────────────────────────────────────────────

export type {
    Params,
    Query,
    RouteLocation,
    RouteComponent,
    Route,
    RouteMatch,
    NavigateTarget,
    NavigateOptions,
    RouterMode,
    RouterConfig,
    HistoryAdapter
} from './types.ts';

export type { Router } from './router.ts';
export type { PathMatcher } from './path-pattern.ts';
export type { LinkProps } from './link.ts';
export type { RoutesProps } from './routes.ts';
export type { OutletProps } from './outlet.ts';
export type { NavigateApi } from './use-route.ts';
