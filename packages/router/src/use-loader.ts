/**
 * MODULE: router/use-loader
 *
 * useLoader returns the live Resource holding the matched route's loader output. There is ONE
 * resource per router, so every useLoader(router) consumer sees the same data/loading/error and
 * shares one refetch(). Its source is the router's match memo, which drives its lifecycle: a match
 * change re-runs the loader; a mid-flight match change aborts the previous fetch via the shared
 * AbortSignal; a null match (404) or a loader-less leaf resets it to the no-fetch state; and
 * router-scope disposal aborts any in-flight fetch.
 *
 * Type caveat: the router cannot know which leaf's loader is active at compile time, so the default
 * return is Resource<unknown>; pass a generic (useLoader<Post>(router)) for a per-call cast. A
 * future typed-routes pass can lift this without changing the call shape.
 */

import type { Resource } from '@azerothjs/reactivity';
import type { Router } from './router.ts';

/**
 * useLoader
 *
 * PURPOSE:
 * Returns the matched route's loader {@link Resource} (data/loading/error/refetch), cast to the
 * caller-supplied type.
 *
 * WHY IT EXISTS:
 * Route data loading needs the same loading/error/cancellation machinery as any async resource,
 * coordinated with navigation. The router already owns one such resource keyed on the active match;
 * useLoader is the ergonomic accessor route components reach for, mirroring other frameworks'
 * useLoaderData.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; a thin accessor over router.loader. The resource's reactivity (re-fetch on match
 * change, abort on supersession) is handled by the router's createResource.
 *
 * INPUT CONTRACT:
 * - router: the Router whose active loader to read.
 *
 * OUTPUT CONTRACT:
 * - The SAME Resource<T> object every call (per router), so reading data()/loading()/error() inside
 *   an effect subscribes to the underlying signals. T is an unchecked cast.
 *
 * WHY THIS DESIGN:
 * Returning the single shared resource (rather than a fresh one) means every consumer observes one
 * coordinated state and one refetch(), and the router controls its lifecycle centrally. The generic
 * is a per-call cast because the active leaf is not known at compile time.
 *
 * WHEN TO USE:
 * Inside a route component to read its loader data, loading flag, error, or to trigger a refetch.
 *
 * WHEN NOT TO USE:
 * For ad-hoc fetches unrelated to routing (use {@link createResource} directly).
 *
 * EDGE CASES:
 * - When no route matches or the matched leaf has no loader, the resource is idle: data() is
 *   undefined and loading() is false.
 * - The T type argument is NOT verified - pass the type matching the route you are rendering.
 *
 * PERFORMANCE NOTES:
 * O(1): returns an existing object; no per-call allocation.
 *
 * DEVELOPER WARNING:
 * The cast is unchecked - a wrong T compiles but lies at runtime. Read the resource inside an effect
 * to stay reactive to its loading/data/error transitions.
 *
 * @typeParam T - The expected resolved-value type (unchecked cast).
 * @param router - The Router whose loader resource to return.
 * @returns The matched route's loader {@link Resource} as Resource<T>.
 * @see {@link createRouter}
 * @see {@link createResource}
 * @example
 * const user = useLoader<User>(router);
 * h('div', {}, () => user.loading() ? 'Loading...' : (user.data()?.name ?? 'No data'));
 */
export function useLoader<T = unknown>(router: Router): Resource<T>
{
    // Single source of truth: every caller gets the same object, so reads inside an effect
    // subscribe to the same underlying signals.
    return router.loader as Resource<T>;
}
