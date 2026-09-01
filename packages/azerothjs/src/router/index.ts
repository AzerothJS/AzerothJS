/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A manual-first client router: an explicit Router instance from createRouter, the
 * <Link>/<Routes>/<Outlet> components, the useRoute/useParams/useQuery/useNavigate/useLoader
 * composables, and the path/query/history utilities. Routes are DATA (passed to createRouter), not
 * a <Route> element; file-based routing can layer on top later. Internal helpers (joinPaths,
 * flattenRoutes, splitFullPath, shallowEqual*) stay unexported in their own files. Every symbol
 * below is documented at its definition.
 */

// Functions

export { createRouter, targetToFullPath, resolveRouteComponent } from './router.ts';
export { defineRoute } from './define-route.ts';
export { redirect } from './redirect.ts';
export { notFound, isNotFound } from './not-found.ts';
export { unauthorized, forbidden, isDenied } from './denied.ts';
export { createBrowserHistory, createMemoryHistory } from './history.ts';
export { compilePath } from './path-pattern.ts';
export { parseQuery, stringifyQuery } from './query.ts';

// Components

export { Link } from './link.ts';
export { Routes } from './routes.ts';
export { Outlet } from './outlet.ts';
export { RouterProvider } from './provider.ts';

// Composables

export {
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate,
    useRevalidate
} from './use-route.ts';
export { useLoader } from './use-loader.ts';
export { useSearch } from './use-search.ts';
export { matchAndLoad, loaderHandoffScript, readLoaderHandoff } from './handoff.ts';
export { LOADER_HANDOFF_ID, LOADER_HANDOFF_VERSION } from './handoff-wire.ts';

// Types

export type {
    LoaderHandoff,
    Params,
    Query,
    RouteLocation,
    RouteComponent,
    Route,
    RouteLoaderArgs,
    RouteMatch,
    GuardContext,
    GuardVerdict,
    RouteState,
    NavigateTarget,
    NavigateOptions,
    RouterMode,
    RouterConfig,
    HistoryAdapter,
    SearchSchemaLike
} from './types.ts';
export type { RouteHandle, RoutePathParams, DefineRouteConfig, ToOptions, LoaderDataOf, SearchOf } from './define-route.ts';
export type { Redirect } from './redirect.ts';
export type { NotFound } from './not-found.ts';
export type { Denied } from './denied.ts';
export type { MatchAndLoadResult } from './handoff.ts';
export type { RouterProviderProps } from './provider.ts';

export type { Router, NavigationKind } from './router.ts';
export type { MountNode } from '../component/index.ts';
export type { PathMatcher } from './path-pattern.ts';
export type { LinkProps } from './link.ts';
export type { RoutesProps, RouteTransitionContext } from './routes.ts';
export type { OutletProps } from './outlet.ts';
export type { NavigateApi } from './use-route.ts';
