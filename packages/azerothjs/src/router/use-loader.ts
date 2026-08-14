/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The live Resource holding a route level's loader output.
 *
 * The router keeps ONE resource per matched-chain level, and all levels load in parallel.
 * This composable answers "which level do you mean" in three ways:
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
        refreshing: () => at()?.refreshing() ?? false,
        error: () => at()?.error() ?? null,
        refetch: (): Promise<void> => at()?.refetch() ?? Promise.resolve()
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
 * The loader {@link Resource} for a route level, typed by the handle it is given.
 *
 * Call it during component CONSTRUCTION, at the top of the body, like every composable. The
 * resource it returns stays live for reads afterwards.
 *
 * The returned getters are views over the router's shared per-level resources, so every
 * consumer of a level sees one coordinated state and one refetch. A level with no loader, or
 * no matching route, reads as idle: data undefined and loading false.
 *
 * The bare-generic form `useLoader<T>(router)` is an unchecked cast; prefer a handle when you
 * want the typing actually verified.
 *
 * @param handle - The route handle whose level to read.
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns A resource typed from the handle's loader.
 * @example
 * const user = useLoader(userRoute); // Resource<User>
 *
 * h('div', {}, () => user.loading() ? 'Loading...' : (user.data()?.name ?? 'No data'));
 */
export function useLoader<Path extends string, Data, Search>(handle: RouteHandle<Path, Data, Search>, router?: Router): Resource<Data>;
/**
 * Untyped form. Called with no arguments inside a route component body it reads THIS
 * component's level, falling back to the nearest ancestor level that declares a loader - which
 * is how a leaf reads its layout's data. Anywhere else it reads the deepest level with a
 * loader, tracking navigation.
 *
 * `T` is an unchecked cast: nothing verifies the loader actually returns it. Pass a route
 * handle instead when you want the typing verified.
 *
 * @typeParam T - Asserted data type, unchecked.
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns The level's resource, idle when that level has no loader.
 */
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
