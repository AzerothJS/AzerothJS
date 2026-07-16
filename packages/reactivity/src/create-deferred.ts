/**
 * MODULE: reactivity/create-deferred
 *
 * createDeferred() wraps a signal getter and returns a new getter whose updates are
 * debounced: subscribers see the new value only after a quiet period (no further source
 * changes) has elapsed. It exists to keep expensive downstream work - filtering large
 * lists, re-rendering a chart, refetching - off the rapid-update path, e.g. filtering
 * only once the user stops typing. It holds the deferred value in an internal signal,
 * watches the source with an effect, and (re)starts a timer on each change; when the
 * timer fires undisturbed it writes the internal signal, re-running its subscribers.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';

/**
 * Options for {@link createDeferred}.
 */
export interface DeferredOptions
{
    /**
     * Debounce delay in milliseconds: the deferred value updates only after this many ms
     * have passed since the LAST source change. Named `delay` (not `timeout`) because it is
     * a quiet-period debounce, not an abort deadline.
     *
     * @default 150
     */
    delay?: number;
}

/**
 * createDeferred
 *
 * PURPOSE:
 * Returns a debounced version of `source`. The new getter's value updates only after
 * `delay` ms with no further source change; the initial value is available
 * immediately (no first-read delay).
 *
 * WHY IT EXISTS:
 * Reacting to every keystroke (or other rapid signal) re-runs expensive consumers far
 * more than needed. Debouncing by hand means a setTimeout/clearTimeout dance in an
 * effect plus a separate held signal - easy to get wrong (leaked timers, stale writes
 * after unmount). createDeferred packages that correctly behind one getter.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. A derived primitive built on createSignal + createEffect;
 * it is timer-driven, so it is a client-side convenience (timers do not advance during
 * synchronous SSR).
 *
 * INPUT CONTRACT:
 * - source: a getter to debounce. Read reactively inside the internal effect.
 * - options.delay: debounce window in ms (default 150).
 *
 * OUTPUT CONTRACT:
 * - Returns a getter for the debounced value, seeded with source's current value and
 *   thereafter trailing it by the delay.
 *
 * WHY THIS DESIGN:
 * The value lives in an internal signal so existing reactivity machinery (subscription,
 * equality) applies unchanged. The effect's cleanup is the single place a pending timer
 * is cancelled, so both a debounce reset (re-run) and unmount (dispose) clear it - no
 * leaked timers, no write after teardown.
 *
 * WHEN TO USE:
 * To gate costly downstream work on a quiet period: search-as-you-type filtering,
 * chart redraws, autosave, debounced fetches.
 *
 * WHEN NOT TO USE:
 * When every change must be observed (use the source directly). Not meaningful in SSR,
 * where timers do not fire within the synchronous render.
 *
 * EDGE CASES:
 * - First read returns the seeded current value with no delay; only subsequent changes
 *   are debounced.
 * - Rapid changes keep resetting the timer, so the value updates once after the burst.
 *
 * PERFORMANCE NOTES:
 * One internal signal + one effect + at most one live timer. Downstream consumers run
 * at most once per quiet period rather than once per source change.
 *
 * DEVELOPER WARNING:
 * Must be created inside a root/component scope so its internal effect (and any pending
 * timer) is disposed on unmount; otherwise a trailing timer can fire after teardown.
 *
 * @typeParam T - The source value type.
 * @param source - A signal getter to debounce.
 * @param options - Optional settings; `options.delay` is the debounce window (ms).
 * @returns A getter returning the debounced value.
 * @see {@link createSignal}
 * @see {@link createEffect}
 * @example
 * const [search, setSearch] = createSignal('');
 * const deferredSearch = createDeferred(search, { delay: 300 });
 * createEffect(() => renderResults(filterItems(deferredSearch())));
 */
export function createDeferred<T>(source: Getter<T>, options?: DeferredOptions): Getter<T>
{
    const delay = options?.delay ?? 150;

    // Seed the internal signal with the current source value (no delay); untrack keeps
    // this read from subscribing any enclosing effect.
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
        }, delay);

        // The single place a pending timer is cancelled. Runs (1) before a re-run when
        // the source changed again (debounce reset, right before scheduling the next
        // timer) and (2) on dispose (stops a stale setDeferred after unmount).
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
