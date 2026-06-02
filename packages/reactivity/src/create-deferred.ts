// createDeferred() wraps a signal getter and returns a new getter whose value
// updates are debounced: subscribers only see the new value after a timeout
// has elapsed since the last change. Use it to keep expensive downstream work
// (filtering large lists, re-rendering a chart, refetching) from running on
// every rapid update - e.g. only filter once the user stops typing.
//
// It holds the deferred value in an internal signal, watches the source with
// an effect, and on each source change (re)starts a timer; when the timer
// fires without further changes it writes the internal signal, re-running its
// subscribers.

import type { Getter } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';
import { untrack } from './untrack.ts';

/**
 * Options for createDeferred.
 */
export interface DeferredOptions
{
    /**
     * The debounce timeout in milliseconds.
     *
     * The deferred value only updates after this many
     * milliseconds have passed since the LAST source change.
     *
     * @default 150
     */
    timeout?: number;
}

/**
 * Creates a deferred (debounced) version of a signal getter. The returned
 * getter's value updates only after `timeout` ms have passed since the last
 * source change, keeping expensive downstream work off the rapid-update path.
 * The initial value is available immediately, with no delay on first read.
 *
 * @typeParam T - The type of the signal's value
 *
 * @param source - A signal getter to debounce
 * @param options - Optional configuration (timeout in ms)
 *
 * @returns A getter that returns the debounced value
 *
 * Why: keeping expensive downstream work off the rapid-update path means
 * debouncing the source yourself with a timer and a separate held value.
 *
 * Without createDeferred: a setTimeout/clearTimeout dance in an effect:
 *
 *     const [delayed, setDelayed] = createSignal(search());
 *     createEffect(() =>
 *     {
 *         const v = search();
 *         const id = setTimeout(() => setDelayed(() => v), 300);
 *         onCleanup(() => clearTimeout(id)); // forget this and timers pile up
 *     });
 *
 * With createDeferred: one call returns the debounced getter:
 *
 *     const deferred = createDeferred(search, { timeout: 300 });
 *     deferred(); // the value as of 300ms after the last change
 *
 * @example
 * ```ts
 * // Debounced search - filters only after the user stops typing
 * const [search, setSearch] = createSignal('');
 * const deferredSearch = createDeferred(search, { timeout: 300 });
 *
 * createEffect(() =>
 * {
 *     // Only runs 300ms after the last setSearch() call
 *     const results = filterItems(deferredSearch());
 *     renderResults(results);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Default timeout (150ms)
 * const [query, setQuery] = createSignal('');
 * const deferredQuery = createDeferred(query);
 * ```
 */
export function createDeferred<T>(source: Getter<T>, options?: DeferredOptions): Getter<T>
{
    const timeout = options?.timeout ?? 150;

    // Seed the internal signal with the current source value (no delay).
    // untrack keeps this read from subscribing any enclosing effect.
    const [deferred, setDeferred] = createSignal<T>(untrack(() => source()));

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let isFirst = true;

    createEffect(() =>
    {
        const current = source();

        // First run: the value was already seeded in createSignal above.
        if (isFirst)
        {
            isFirst = false;
            return;
        }

        timerId = setTimeout(() =>
        {
            timerId = null;
            setDeferred(() => current);
        }, timeout);

        // The returned cleanup is the single place a pending timer is
        // cancelled. It runs in two situations, both intended:
        //   1. Before the effect re-runs (source changed again) - the debounce
        //      reset, clearing the previous timer right before a fresh one is
        //      scheduled above.
        //   2. On dispose (root teardown) - stops a stale setDeferred from
        //      firing after unmount.
        return () =>
        {
            if (timerId !== null)
            {
                clearTimeout(timerId);
                timerId = null;
            }
        };
    });

    return deferred;
}
