// ============================================================================
// AZEROTHJS — Route Composables
// ============================================================================
//
// Five small primitives that wrap a `Router` and give the user
// the slice they actually care about.
//
//   useRoute(router)     →  the full RouteLocation snapshot
//   useMatch(router)     →  the matched route + chain (or null)
//   useParams(router)    →  just the path params, slice-memoized
//   useQuery(router)     →  just the query, slice-memoized
//   useNavigate(router)  →  imperative navigation API as one object
//
// WHY THESE EXIST WHEN router.location ALREADY DOES IT:
//
//   1. Slice memoization. `useParams` re-fires only when the
//      params actually change — navigating from `/users/42` to
//      `/users/42#bio` updates the location signal but leaves
//      params identical, so `useParams` skips the notification.
//      Same for `useQuery`.
//
//   2. Future context API. When we add `<RouterProvider>` later,
//      these composables will resolve the router from context
//      instead of taking it as an argument. Introducing the
//      indirection now means user code doesn't change shape on
//      that day — only the call signature drops the `router`
//      argument.
//
// ============================================================================

import type { Getter } from '@azerothjs/reactivity';
import { createMemo } from '@azerothjs/reactivity';
import type { Params, Query, RouteLocation, RouteMatch } from './types.ts';
import type { Router } from './router.ts';

/**
 * Shallow-equal comparison for `Record<string, string | string[]>`
 * shapes — covers both `Params` (string values only) and `Query`
 * (string or string[] values).
 *
 * Used as the `equals` option on the params/query memos so they
 * re-fire only when their slice has *actually* changed, not on
 * every location update that happens to leave their slice intact.
 *
 * `createMemo` never invokes `equals` with its initial placeholder
 * (a memo's first computed value is always accepted), so in
 * practice both arguments are real record objects. The `a === b`
 * fast path and the `== null` guard below are kept as cheap
 * defensive checks regardless.
 *
 * @internal
 */
function shallowEqualRecord(
    a: Record<string, string | string[]>,
    b: Record<string, string | string[]>
): boolean
{
    if (a === b)
    {
        return true;
    }
    if (a == null || b == null)
    {
        return false;
    }

    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length)
    {
        return false;
    }

    for (const k of keysA)
    {
        const va = a[k];
        const vb = b[k];
        if (va === vb)
        {
            continue;
        }

        // Both arrays — compare element by element. Ordering matters,
        // matching how parseQuery preserves insertion order.
        if (Array.isArray(va) && Array.isArray(vb))
        {
            if (va.length !== vb.length)
            {
                return false;
            }
            for (let i = 0; i < va.length; i++)
            {
                if (va[i] !== vb[i])
                {
                    return false;
                }
            }
            continue;
        }

        // Mixed shape (one is array, the other isn't) → not equal.
        return false;
    }

    return true;
}

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
 * Returns a getter for the currently matched route (with full
 * root → leaf chain), or `null` if no route matches.
 *
 * Already memoized in the router with structural equality on
 * route + params, so cosmetic location changes (e.g. only the
 * hash) do not invalidate it.
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
 * Re-fires only when the params object's keys or values change —
 * navigating to the same route with the same params (e.g. only
 * the hash changed) leaves this getter quiet.
 *
 * @example
 * ```ts
 * // Inside a component for /users/:id
 * const params = useParams(router);
 *
 * createEffect(() =>
 * {
 *     fetchUser(params().id);
 *     // …only re-fetches when id actually changes.
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
 * The shape returned by `useNavigate()` — one object bundling
 * every imperative navigation method.
 *
 * Methods are taken straight off the router (they don't rely on
 * `this` binding internally), so destructuring is safe:
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
