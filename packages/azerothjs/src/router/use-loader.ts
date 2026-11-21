/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A resource view for one route level's loader output.
 *
 * The router keeps ONE resource per matched-chain level, and all levels load in parallel.
 * This composable answers "which level do you mean" in three ways:
 *
 *   - `useLoader()` inside a route component - this segment's level, falling back to the nearest ANCESTOR level that
 *     declares a loader when this one doesn't - a leaf reading its layout's data.
 *   - `useLoader(handle)` - the level where that {@link RouteHandle} sits in the current
 *     match, TYPED from the handle's loader (`Resource<Data>`, with null added when Data
 *     admits undefined). Idle when the handle is not part of the current match.
 *   - `useLoader(router)` / bare `useLoader()` outside a chain - the DEEPEST level with
 *     a loader (the v1 "leaf loader" semantics), tracking navigation reactively.
 *
 * A mounted segment keeps the last outcome for its displayed key during a cold navigation
 * or leave transition. Consumers of the active key share one fetch per level.
 */

import type { Getter, Resource } from '../reactivity/index.ts';
import { createMemo, getOwner, isStringMode, runWithOwner, untrack } from '../reactivity/index.ts';
import type { RouteMatch } from './types.ts';
import type { Router } from './router.ts';
import type { RouteHandle } from './define-route.ts';
import { currentRouteFrame, resolveRouter } from './provider.ts';

const idle: Resource<unknown> = {
    data: () => undefined,
    error: () => null,
    loading: () => false,
    refreshing: () => false,
    refetch: () => Promise.resolve()
};

/** @internal The deepest matched level declaring a loader, or null. */
function deepestLoaderLevel(m: RouteMatch | null): number | null
{
    for (let level = (m?.matched.length ?? 0) - 1; level >= 0; level--)
    {
        if (m?.matched[level]?.loader)
        {
            return level;
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
 * A displayed segment keeps its loader fields when the router switches keys. Refetching
 * through a retired segment or an obsolete key resolves without starting another request.
 * A level with no matching loader reads as idle, with undefined data and loading false.
 *
 * A loader that resolves undefined reads null on a server-rendered page, on the server and
 * after hydration, since the handoff reaches the browser as JSON; a level the client loads
 * itself, on a navigation or a client-rendered page, reads undefined. Such a loader's data is
 * typed as possibly null too, so read it as `data()?.name ?? fallback` rather than telling
 * undefined from null.
 *
 * The bare-generic form `useLoader<T>(router)` is an unchecked cast; prefer a handle when you
 * want the typing actually verified.
 *
 * @param handle - The route handle whose level to read.
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns A resource typed from the handle's loader, with null added when its data admits
 *          undefined.
 * @example
 * const user = useLoader(userRoute); // Resource<User>
 *
 * h('div', {}, () => user.loading() ? 'Loading...' : (user.data()?.name ?? 'No data'));
 */
export function useLoader<Path extends string, Data, Search>(handle: RouteHandle<Path, Data, Search>, router?: Router): Resource<undefined extends Data ? Data | null : Data>;
/**
 * Untyped form. Called with no arguments inside a route component body it reads THIS
 * component's level, falling back to the nearest ancestor level that declares a loader - which
 * is how a leaf reads its layout's data. Anywhere else it reads the deepest level with a
 * loader, tracking navigation.
 *
 * `T` is an unchecked cast: nothing verifies the loader actually returns it. Pass a route
 * handle instead when you want the typing verified. A loader that resolves undefined reads
 * null on a server-rendered page, so a `T` that admits undefined gets null added; read such
 * data as `data()?.name ?? fallback`.
 *
 * @typeParam T - Asserted data type, unchecked.
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns The level's resource, idle when that level has no loader, with null added when `T`
 *          admits undefined.
 */
export function useLoader<T = unknown>(router?: Router): Resource<undefined extends T ? T | null : T>;
export function useLoader(
    first?: Router | RouteHandle<string, unknown, unknown>, second?: Router
): Resource<unknown>
{
    const handle = first !== undefined && 'path' in first ? first : undefined;
    const router = resolveRouter(first !== undefined && !('path' in first) ? first : second, 'useLoader');
    const context = currentRouteFrame();
    const frame = context?.router === router ? context : null;
    const match = frame?.match ?? router.match;
    const level = createMemo(() =>
    {
        const m = match();
        if (handle !== undefined)
        {
            const index = m?.matched.indexOf(handle) ?? -1;
            return index < 0 ? null : index;
        }
        if (m === null)
        {
            return null;
        }
        if (first === undefined && frame !== null)
        {
            let index = frame.level;
            while (index > 0 && m.matched[index]?.loader === undefined)
            {
                index--;
            }
            return index;
        }
        return deepestLoaderLevel(m);
    });
    const read = (): Resource<unknown> =>
    {
        const index = level();
        if (index === null)
        {
            return idle;
        }
        return (frame === null ? router.loaders[index] : frame.loader(index)) ?? idle;
    };
    if (isStringMode())
    {
        // A numbered Suspense boundary looks up the original resource in its stream session.
        return untrack(read);
    }
    // Selecting a new key can leave an individual field unchanged. Subscribe only to
    // the fields the caller reads, and keep each memo with the hook's original owner.
    const owner = getOwner();
    function field<T>(sample: Getter<T>): Getter<T>
    {
        if (frame === null)
        {
            return sample;
        }
        let memo: Getter<T> | undefined;
        return () =>
        {
            if (owner?.disposed)
            {
                return sample();
            }
            memo ??= runWithOwner(owner, () => createMemo(sample));
            return memo();
        };
    }
    return {
        data: field(() => read().data()),
        error: field(() => read().error()),
        loading: field(() => read().loading()),
        refreshing: field(() => read().refreshing()),
        refetch: () => untrack(() => frame?.active() === false ? idle.refetch() : read().refetch())
    };
}
