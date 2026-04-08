// ============================================================================
// AZEROTHJS — createDeferred (Debounced Reactive Value)
// ============================================================================
//
// createDeferred() wraps a signal getter and returns a new getter
// whose value updates are delayed (debounced). Subscribers only
// see the new value after a timeout since the LAST change.
//
// WHY?
//
//   Some reactive updates are expensive:
//     - Filtering thousands of items on every keystroke
//     - Re-rendering a complex chart on every slider move
//     - Fetching data on every input change
//
//   createDeferred lets you debounce these updates automatically:
//
//     const [search, setSearch] = createSignal('');
//     const deferredSearch = createDeferred(search, { timeout: 300 });
//
//     // This effect only runs 300ms after the user STOPS typing
//     createEffect(() =>
//     {
//         const results = filterItems(deferredSearch());
//         renderResults(results);
//     });
//
// HOW IT WORKS:
//
//   1. Creates an internal signal to hold the deferred value
//   2. An effect watches the source getter
//   3. On change, it starts/resets a setTimeout
//   4. When the timeout fires (no new changes), it updates
//      the internal signal
//   5. Subscribers of the deferred getter then re-run
//
//   Source:   "h" → "he" → "hel" → "hell" → "hello"
//   Deferred: "h" ─────────────────────────→ "hello" (after timeout)
//
// ============================================================================

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
 * Creates a deferred (debounced) version of a signal getter.
 *
 * The returned getter's value updates only after `timeout` ms
 * have passed since the last change in the source getter.
 * This prevents expensive downstream computations from running
 * on every rapid update.
 *
 * The initial value is set immediately (no delay on first read).
 *
 * @typeParam T - The type of the signal's value
 *
 * @param source - A signal getter to debounce
 * @param options - Optional configuration (timeout in ms)
 *
 * @returns A getter that returns the debounced value
 *
 * @example
 * ```ts
 * // Debounced search — filters only after user stops typing
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
 * // Debounced slider — avoids re-rendering on every pixel
 * const [value, setValue] = createSignal(50);
 * const smoothValue = createDeferred(value, { timeout: 100 });
 *
 * createEffect(() =>
 * {
 *     renderExpensiveChart(smoothValue());
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

    // Internal signal holds the deferred value
    // Initialized with the current source value (no delay)
    // untrack prevents the parent effect from subscribing to source
    const [deferred, setDeferred] = createSignal<T>(untrack(() => source()));

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let isFirst = true;

    // Watch the source — debounce updates to the internal signal
    createEffect(() =>
    {
        const current = source();

        // First run: value already set in createSignal above
        if (isFirst)
        {
            isFirst = false;
            return;
        }

        // Clear any pending timeout (debounce reset)
        if (timerId !== null)
        {
            clearTimeout(timerId);
        }

        // Schedule the deferred update
        timerId = setTimeout(() =>
        {
            timerId = null;
            setDeferred(() => current);
        }, timeout);

        // Clean up timeout if effect re-runs or disposes
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
