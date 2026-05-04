// ============================================================================
// AZEROTHJS — useLoader Composable
// ============================================================================
//
// Returns the live `Resource` that holds the matched route's
// loader output. One resource per router — every consumer of
// `useLoader(router)` sees the same data, loading, error, and
// can call the same `refetch()`.
//
// LIFECYCLE:
//
//   The resource's source is the router's `match` memo. So:
//
//     - Match changes (route or params change) → loader re-runs
//     - Match changes mid-flight              → previous fetch
//                                              aborts via the
//                                              shared AbortSignal
//     - Match becomes null (404)              → resource resets
//                                              to "no fetch" state
//     - Matched leaf has no loader            → same as above
//     - Router scope disposes                 → in-flight aborts,
//                                              resource cleanup
//
// TYPE-SAFETY CAVEAT:
//
//   The router can't know which leaf's loader is active at
//   compile time. The default return is `Resource<unknown>` —
//   pass a generic argument to apply a per-call cast:
//
//     const post = useLoader<Post>(router);
//
//   This is a worse contract than per-route generics but matches
//   the manual API. A future "typed routes" pass can lift this
//   without breaking the call shape.
//
// ============================================================================

import type { Resource } from '@azerothjs/reactivity';
import type { Router } from './router.ts';

/**
 * Returns the matched route's loader resource.
 *
 * Same `Resource` object every call (per router instance) —
 * subscribing inside an effect tracks the underlying signals
 * directly.
 *
 * @typeParam T - The expected shape of the loader's resolved
 *                value. The cast is unchecked; pass the type
 *                that matches the route you're rendering.
 *
 * @example
 * ```ts
 * // Inside a route component for /users/:id
 * const user = useLoader<User>(router);
 *
 * h('div', {}, () =>
 * {
 *     if (user.loading()) return 'Loading…';
 *     if (user.error()) return `Error: ${ String(user.error()) }`;
 *     return user.data()?.name ?? 'No data';
 * });
 * ```
 *
 * @example
 * ```ts
 * // Manual refetch — for an explicit "Refresh" button
 * const list = useLoader<Post[]>(router);
 *
 * h('button', { onClick: () => list.refetch() }, 'Refresh');
 * ```
 */
export function useLoader<T = unknown>(router: Router): Resource<T>
{
    // Single source of truth — every caller gets the same object,
    // so reads inside an effect subscribe to the same underlying
    // signals (which is what we want).
    return router.loader as Resource<T>;
}
