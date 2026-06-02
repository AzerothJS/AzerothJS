// Public API for the router. A manual-first router: explicit Router instance,
// <Link>/<Routes>/<Outlet> components, and the useRoute/useParams/useQuery/
// useNavigate composables. File-based routing layers on top of this later.
//
// Internal helpers (joinPaths, flattenRoutes, splitFullPath, shallowEqualParams,
// shallowEqualRecord) stay unexported in their own files.

// Functions

export { createRouter, targetToFullPath } from './router.ts';
export { createBrowserHistory } from './history.ts';
export { compilePath } from './path-pattern.ts';
export { parseQuery, stringifyQuery } from './query.ts';

// Components

export { Link } from './link.ts';
export { Routes } from './routes.ts';
export { Outlet } from './outlet.ts';

// Composables

export {
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate
} from './use-route.ts';
export { useLoader } from './use-loader.ts';

// Types

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
