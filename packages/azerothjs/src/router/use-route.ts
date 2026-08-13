/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Five composables handing back the slice of a Router the caller actually cares about:
 *
 *     useRoute    -> the full RouteLocation snapshot
 *     useMatch    -> the matched route and chain, or null
 *     useParams   -> the path params, slice-memoized
 *     useQuery    -> the query, slice-memoized
 *     useNavigate -> the imperative navigation API, as one destructurable object
 *
 * They exist rather than reading `router.location` directly for slice memoization: navigating
 * from `/users/42` to `/users/42#bio` updates the location signal but leaves the params
 * identical, so useParams stays quiet where a raw location read would re-fire.
 *
 * Each resolves the router from context when its argument is omitted, and the explicit
 * argument remains an override for tests and nested routers.
 */

import type { Getter } from '../reactivity/index.ts';
import { createMemo } from '../reactivity/index.ts';
import type { Params, Query, RouteLocation, RouteMatch } from './types.ts';
import type { Router } from './router.ts';
import { shallowEqualRecord } from './shallow-equal.ts';
import { resolveRouter } from './provider.ts';

/**
 * Returns a getter for the full reactive `RouteLocation`.
 *
 * Equivalent to `router.location`; with no argument the router
 * resolves from the nearest <RouterProvider>.
 *
 * @example
 * ```ts
 * const location = useRoute(router);
 *
 * createEffect(() =>
 * {
 *     console.log('At:', location().pathname);
 * });
 * ```
 */
export function useRoute(router?: Router): Getter<RouteLocation>
{
    return resolveRouter(router, 'useRoute').location;
}

/**
 * Returns a getter for the currently matched route (with full root-to-leaf
 * chain), or `null` if no route matches.
 *
 * Already memoized in the router with structural equality on route + params, so
 * cosmetic location changes (e.g. only the hash) do not invalidate it.
 *
 * @example
 * ```ts
 * const match = useMatch(router);
 *
 * createEffect(() =>
 * {
 *     const m = match();
 *     if (m === null) console.log('404');
 *     else console.log('Matched:', m.route.name);
 * });
 * ```
 */
export function useMatch(router?: Router): Getter<RouteMatch | null>
{
    return resolveRouter(router, 'useMatch').match;
}

/**
 * Returns a getter for the current path params, slice-memoized.
 *
 * Re-fires only when the params object's keys or values change; navigating to
 * the same route with the same params (e.g. only the hash changed) leaves this
 * getter quiet.
 *
 * @example
 * ```ts
 * // Inside a component for /users/:id
 * const params = useParams(router);
 *
 * createEffect(() =>
 * {
 *     fetchUser(params().id);
 *     // ...only re-fetches when id actually changes.
 * });
 * ```
 */
export function useParams(router?: Router): Getter<Params>
{
    const resolved = resolveRouter(router, 'useParams');
    return createMemo<Params>(
        () => resolved.location().params,
        { equals: shallowEqualRecord }
    );
}

/**
 * Returns a getter for the current parsed query, slice-memoized.
 *
 * Re-fires only when the query object's keys or values change.
 * Repeated keys (`?tags=a&tags=b`) come back as arrays; both
 * shapes are handled by the equality check.
 *
 * @example
 * ```ts
 * const query = useQuery(router);
 *
 * createEffect(() =>
 * {
 *     const page = Number(query().page ?? '1');
 *     loadPage(page);
 * });
 * ```
 */
export function useQuery(router?: Router): Getter<Query>
{
    const resolved = resolveRouter(router, 'useQuery');
    return createMemo<Query>(
        () => resolved.location().query,
        { equals: shallowEqualRecord }
    );
}

/**
 * The shape returned by `useNavigate()`: one object bundling every imperative
 * navigation method.
 *
 * Methods are taken straight off the router (they don't rely on `this` binding
 * internally), so destructuring is safe:
 *
 * ```ts
 * const { navigate, replace } = useNavigate(router);
 * navigate('/somewhere');
 * ```
 */
export interface NavigateApi
{
    navigate: Router['navigate'];
    replace: Router['replace'];
    back: Router['back'];
    forward: Router['forward'];
}

/**
 * Returns an object bundling every imperative navigation method
 * on the router.
 *
 * Designed for ergonomic destructuring. Modern frameworks all
 * expose a `useNavigate` hook; we meet users where they expect
 * to be.
 *
 * @example
 * ```ts
 * const { navigate, replace } = useNavigate(router);
 *
 * h('button', { onClick: () => navigate('/login') }, 'Sign in');
 * h('button', { onClick: () => replace('/home') },  'Go home (no back stack)');
 * ```
 */
export function useNavigate(router?: Router): NavigateApi
{
    const resolved = resolveRouter(router, 'useNavigate');
    return {
        navigate: resolved.navigate,
        replace: resolved.replace,
        back: resolved.back,
        forward: resolved.forward
    };
}
