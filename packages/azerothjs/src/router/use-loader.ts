/**
 * MODULE: router/use-loader
 *
 * useLoader returns the live Resource holding a route level's loader output. The router
 * keeps ONE resource per matched-chain level (all levels load in parallel); this
 * composable answers "which level do you mean" three ways:
 *
 *   - `useLoader()` inside a route component - THIS component's level (the construction
 *     frame `<Routes>` provides), falling back to the nearest ANCESTOR level that
 *     declares a loader when this one doesn't - a leaf reading its layout's data.
 *   - `useLoader(handle)` - the level where that {@link RouteHandle} sits in the current
 *     match, TYPED as `Resource<Data>` from the handle's loader. Idle when the handle is
 *     not part of the current match.
 *   - `useLoader(router)` / bare `useLoader()` outside a chain - the DEEPEST level with
 *     a loader (the v1 "leaf loader" semantics), tracking navigation reactively.
 *
 * Every form returns getters over the router's own per-level resources, so consumers
 * share one coordinated data/loading/error state and one refetch per level.
 */

import type { Getter, Resource } from '../reactivity/index.ts';
import { createMemo, untrack } from '../reactivity/index.ts';
import type { Router } from './router.ts';
import type { RouteHandle } from './define-route.ts';
import { currentRouteFrame, resolveRouter } from './provider.ts';

/** @internal A Resource view over a LEVEL THAT MOVES (reactive level index into router.loaders). */
function levelResource(router: Router, level: Getter<number | null>): Resource<unknown>
{
    const at = (): Resource<unknown> | null =>
    {
        const index = level();
        return index === null ? null : router.loaders[index] ?? null;
    };
    return {
        data: () => at()?.data(),
        loading: () => at()?.loading() ?? false,
        error: () => at()?.error() ?? null,
        refetch: (): void => at()?.refetch()
    };
}

/** @internal The deepest matched level declaring a loader, or null. */
function deepestLoaderLevel(router: Router): number | null
{
    const m = router.match();
    if (m === null)
    {
        return null;
    }
    for (let i = m.matched.length - 1; i >= 0; i--)
    {
        if (m.matched[i]?.loader)
        {
            return i;
        }
    }
    return null;
}

/**
 * useLoader
 *
 * PURPOSE:
 * Returns the loader {@link Resource} (data/loading/error/refetch) for a route level -
 * this component's own level, a handle's level (typed), or the deepest loading level.
 *
 * INPUT CONTRACT:
 * - `useLoader()` (no arguments) inside a route component body: this level. Outside a
 *   component build it needs a router from `<RouterProvider>` context and reads the
 *   deepest loading level.
 * - `useLoader(handle, router?)`: that handle's level, `Resource<Data>` - no cast.
 * - `useLoader(router)`: explicit router, deepest loading level (the v1 shape).
 *
 * OUTPUT CONTRACT:
 * - Getters over the router's shared per-level resources: consumers see one
 *   coordinated state and one refetch() per level. Idle (data undefined, loading
 *   false) when the level has no loader or no route matches.
 *
 * DEVELOPER WARNING:
 * Call it during component CONSTRUCTION (the top of the component body), like every
 * composable; the returned resource stays live for later reads. The bare-generic cast
 * (`useLoader<T>(router)`) remains unchecked - prefer a handle for checked typing.
 *
 * @example
 * const user = useLoader(userRoute);            // Resource<User> - typed by the handle
 * h('div', {}, () => user.loading() ? 'Loading...' : (user.data()?.name ?? 'No data'));
 */
export function useLoader<Path extends string, Data, Search>(handle: RouteHandle<Path, Data, Search>, router?: Router): Resource<Data>;
export function useLoader<T = unknown>(router?: Router): Resource<T>;
export function useLoader(
    first?: Router | RouteHandle<string, unknown, unknown>, second?: Router
): Resource<unknown>
{
    // A handle carries `path`; a router never does.
    if (first !== undefined && 'path' in first)
    {
        const handle = first;
        const router = resolveRouter(second, 'useLoader');
        const level = createMemo<number | null>(() =>
        {
            const m = router.match();
            const index = m?.matched.indexOf(handle) ?? -1;
            return index === -1 ? null : index;
        });
        return levelResource(router, level);
    }

    // Inside a chain build: THIS level, or the nearest ancestor that loads.
    const frame = currentRouteFrame();
    if (first === undefined && frame !== null)
    {
        const chain = untrack(() => frame.router.match())?.matched;
        let level = frame.level;
        while (level > 0 && chain?.[level]?.loader === undefined)
        {
            level--;
        }
        return frame.router.loaders[level] ?? levelResource(frame.router, () => null);
    }

    // The v1 shape: the deepest loading level of whatever is matched, reactively.
    const router = resolveRouter(first, 'useLoader');
    return levelResource(router, createMemo(() => deepestLoaderLevel(router)));
}
