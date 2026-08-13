/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A debounced view of a getter: the deferred value lives in an internal signal, an effect
 * watches the source and restarts a timer on every change, and only an undisturbed timer
 * writes the signal. Keeps expensive downstream work off the rapid-update path.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';

/** Options for {@link createDeferred}. */
export interface DeferredOptions
{
    /**
     * Quiet period in milliseconds. The deferred value updates only once this long has
     * passed since the LAST source change, so it is a debounce window and not an abort
     * deadline. Defaults to 150.
     */
    delay?: number;

    /** Debug name for devtools; labels the deferred value and groups its internals. */
    name?: string;
}

/**
 * Returns a debounced view of `source`: a getter whose value updates only after `delay`
 * milliseconds pass with no further change. A burst of changes produces exactly one update
 * at the end of the burst.
 *
 * The initial value is seeded immediately, so the first read costs nothing - only
 * subsequent changes are delayed.
 *
 * Create it inside a scope. The pending timer is cancelled by the internal effect's
 * cleanup, which runs both on a debounce reset and on disposal; unowned, a trailing timer
 * can still fire after teardown.
 *
 * Timer-driven, so it has no effect during synchronous SSR - the timer never fires within
 * the render and consumers see the seeded value.
 *
 * @typeParam T - The source value type.
 * @param source - The getter to debounce.
 * @param options - Optional settings.
 * @param options.delay - Quiet period in milliseconds. Defaults to 150.
 * @param options.name - Debug name for devtools.
 * @returns A getter for the debounced value.
 * @example
 * const [search, setSearch] = createSignal('');
 * const deferredSearch = createDeferred(search, { delay: 300 });
 *
 * // Filters once the typing stops, not on every keystroke.
 * createEffect(() => renderResults(filterItems(deferredSearch())));
 *
 * @see {@link createSignal}
 */
export function createDeferred<T>(source: Getter<T>, options?: DeferredOptions): Getter<T>
{
    const delay = options?.delay ?? 150;
    const frame = dtEnterPrimitive('deferred', options?.name);

    // untrack keeps the seeding read from subscribing any enclosing effect.
    const [deferred, setDeferred] = createSignal<T>(untrack(() => source()), { name: options?.name });

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let isFirst = true;

    createEffect(() =>
    {
        const current = source();

        // Already seeded by createSignal above.
        if (isFirst)
        {
            isFirst = false;
            return;
        }

        timerId = setTimeout(() =>
        {
            timerId = null;
            setDeferred(() => current);
        }, delay);

        // The single place a pending timer is cancelled: before a re-run, which is the
        // debounce reset, and on dispose, which stops a stale write after unmount.
        return () =>
        {
            if (timerId !== null)
            {
                clearTimeout(timerId);
                timerId = null;
            }
        };
    });

    dtExitPrimitive(frame);
    return deferred;
}
