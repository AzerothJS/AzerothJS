/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Composables for the route state a caller observes:
 *
 *     useRoute    -> the full RouteLocation snapshot
 *     useMatch    -> the matched route and chain, or null
 *     useRenderedMatch -> the ready selection of the enclosing Routes dispatcher
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
import { currentRouteFrame, resolveRouter } from './provider.ts';

/**
 * Returns a getter for the full reactive `RouteLocation`.
 *
 * URL fields follow the current history entry. Inside a matching routed segment,
 * params follow its displayed match. Outside that scope this returns `router.location`.
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
    const resolved = resolveRouter(router, 'useRoute');
    const frame = currentRouteFrame();
    if (frame === null || frame.router !== resolved)
    {
        return resolved.location;
    }
    return createMemo(() =>
    {
        const location = resolved.location();
        const params = frame.match()?.params ?? {};
        return params === location.params ? location : { ...location, params };
    });
}

/**
 * Returns a getter for the currently matched route (with full root-to-leaf
 * chain), or `null` if no route matches.
 *
 * Inside a matching routed segment this follows its selection through a hold or
 * leave. Outside a segment it follows the admitted route. Hash changes preserve the match.
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
    const resolved = resolveRouter(router, 'useMatch');
    const frame = currentRouteFrame();
    return frame !== null && frame.router === resolved ? frame.match : resolved.match;
}

/**
 * The route ready for the enclosing Routes instance to display, or null for its fallback.
 * Use a change of this getter to retry an outlet boundary when the replacement is ready.
 * A synchronous read can precede DOM placement. Requires a matching Routes context.
 */
export function useRenderedMatch(router?: Router): Getter<RouteMatch | null>
{
    const frame = currentRouteFrame();
    if (frame === null || (router !== undefined && frame.router !== router))
    {
        throw new Error('useRenderedMatch() requires a matching <Routes> context.');
    }
    return frame.rendered;
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
    const frame = currentRouteFrame();
    const readMatch = frame !== null && frame.router === resolved ? frame.match : resolved.match;
    return createMemo<Params>(
        () => readMatch()?.params ?? {},
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

/**
 * Returns the router's `revalidate`: marks every loader entry of the current location
 * stale, refetches the watched ones, and resolves when those refetches settle. The one
 * call a component makes after a mutation changed what the page's loaders would return.
 *
 * @example
 * ```ts
 * const revalidate = useRevalidate();
 *
 * h('button', { onClick: () => void revalidate() }, 'Refresh');
 * ```
 */
export function useRevalidate(router?: Router): () => Promise<void>
{
    return resolveRouter(router, 'useRevalidate').revalidate;
}
