/**
 * MODULE: @azerothjs/router - public API
 *
 * A manual-first client router: an explicit Router instance from createRouter, the
 * <Link>/<Routes>/<Outlet> components, the useRoute/useParams/useQuery/useNavigate/useLoader
 * composables, and the path/query/history utilities. Routes are DATA (passed to createRouter), not
 * a <Route> element; file-based routing can layer on top later. Internal helpers (joinPaths,
 * flattenRoutes, splitFullPath, shallowEqual*) stay unexported in their own files. Every symbol
 * below is documented at its definition.
 */

// Functions

export { createRouter, targetToFullPath } from './router.ts';
export { createBrowserHistory, createMemoryHistory } from './history.ts';
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
export { matchAndLoad, loaderHandoffScript, readLoaderHandoff, LOADER_HANDOFF_ID } from './handoff.ts';

// Types

export type {
    LoaderHandoff,
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

export type { Router, NavigationKind } from './router.ts';
// Re-exported from @azerothjs/component: the return contract RouteComponent uses.
export type { MountNode } from '@azerothjs/component';
export type { PathMatcher } from './path-pattern.ts';
export type { LinkProps } from './link.ts';
export type { RoutesProps, RouteTransitionContext } from './routes.ts';
export type { OutletProps } from './outlet.ts';
export type { NavigateApi } from './use-route.ts';
