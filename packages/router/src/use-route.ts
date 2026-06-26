/**
 * MODULE: router/use-route
 *
 * Five small composables that wrap a Router and hand the user the slice they care about:
 *   useRoute(router)    -> the full RouteLocation snapshot
 *   useMatch(router)    -> the matched route + chain (or null)
 *   useParams(router)   -> just the path params, slice-memoized
 *   useQuery(router)    -> just the query, slice-memoized
 *   useNavigate(router) -> the imperative navigation API as one (destructurable) object
 *
 * WHY they exist when router.location already does it: (1) SLICE MEMOIZATION - useParams/useQuery
 * re-fire only when their slice actually changes (navigating /users/42 -> /users/42#bio updates the
 * location signal but leaves params identical, so useParams stays quiet); (2) a FUTURE CONTEXT API
 * - when <RouterProvider> lands these will resolve the router from context instead of an argument,
 * so user code does not change shape, only the call drops the router argument. Each composable is a
 * thin wrapper; its contract is documented at its definition below.
 */

import type { Getter } from '@azerothjs/reactivity';
import { createMemo } from '@azerothjs/reactivity';
import type { Params, Query, RouteLocation, RouteMatch } from './types.ts';
import type { Router } from './router.ts';
import { shallowEqualRecord } from './shallow-equal.ts';

/**
 * Returns a getter for the full reactive `RouteLocation`.
 *
 * Equivalent to `router.location` today; the indirection exists
 * so user code stays unchanged when we introduce a context-based
 * resolver later.
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
export function useRoute(router: Router): Getter<RouteLocation>
{
    return router.location;
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
export function useMatch(router: Router): Getter<RouteMatch | null>
{
    return router.match;
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
export function useParams(router: Router): Getter<Params>
{
    return createMemo<Params>(
        () => router.location().params,
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
export function useQuery(router: Router): Getter<Query>
{
    return createMemo<Query>(
        () => router.location().query,
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
export function useNavigate(router: Router): NavigateApi
{
    return {
        navigate: router.navigate,
        replace: router.replace,
        back: router.back,
        forward: router.forward
    };
}
