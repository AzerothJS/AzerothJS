// Returns the live Resource holding the matched route's loader output. One
// resource per router, so every consumer of useLoader(router) sees the same
// data, loading, and error, and can call the same refetch().
//
// The resource's source is the router's match memo, which drives its lifecycle:
//   - Match changes (route or params change): loader re-runs.
//   - Match changes mid-flight: the previous fetch aborts via the shared
//     AbortSignal.
//   - Match becomes null (404), or the matched leaf has no loader: the resource
//     resets to the no-fetch state.
//   - Router scope disposes: in-flight fetch aborts and the resource cleans up.
//
// Type-safety caveat: the router can't know which leaf's loader is active at
// compile time, so the default return is Resource<unknown>. Pass a generic
// argument to apply a per-call cast:
//
//     const post = useLoader<Post>(router);
//
// This is a weaker contract than per-route generics but matches the manual API.
// A future typed-routes pass can lift it without breaking the call shape.

import type { Resource } from '@azerothjs/reactivity';
import type { Router } from './router.ts';

/**
 * Returns the matched route's loader resource.
 *
 * Returns the same `Resource` object every call (per router instance), so
 * subscribing inside an effect tracks the underlying signals directly.
 *
 * @typeParam T - The expected shape of the loader's resolved value. The cast is
 *                unchecked; pass the type that matches the route you're
 *                rendering.
 *
 * @example
 * ```ts
 * // Inside a route component for /users/:id
 * const user = useLoader<User>(router);
 *
 * h('div', {}, () =>
 * {
 *     if (user.loading()) return 'Loading...';
 *     if (user.error()) return `Error: ${ String(user.error()) }`;
 *     return user.data()?.name ?? 'No data';
 * });
 * ```
 *
 * @example
 * ```ts
 * // Manual refetch for an explicit "Refresh" button
 * const list = useLoader<Post[]>(router);
 *
 * h('button', { onClick: () => list.refetch() }, 'Refresh');
 * ```
 */
export function useLoader<T = unknown>(router: Router): Resource<T>
{
    // Single source of truth: every caller gets the same object, so reads
    // inside an effect subscribe to the same underlying signals.
    return router.loader as Resource<T>;
}
