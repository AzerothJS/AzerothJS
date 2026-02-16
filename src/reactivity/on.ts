// ============================================================================
// QUANTUM FRAMEWORK — on() (Explicit Dependency Tracking)
// ============================================================================
//
// on() creates an effect that explicitly declares which signals
// it depends on, instead of auto-tracking.
//
// WHY?
//
//   createEffect(() =>
//   {
//       // This auto-tracks EVERYTHING read inside
//       console.log(a(), b(), c(), d(), e());
//       // Changes to ANY of these re-run the effect
//   });
//
//   on([a, b], ([aVal, bVal]) =>
//   {
//       // This ONLY tracks a and b
//       // c, d, e can be read without subscribing
//       console.log(aVal, bVal, c(), d(), e());
//       // Only changes to a or b re-run this
//   });
//
// ============================================================================

import type { Getter, DisposeFn } from './types.ts';
import { createEffect } from './effect.ts';
import { untrack } from './untrack.ts';

/**
 * Creates an effect with explicit dependency tracking.
 *
 * Instead of automatically tracking all signals read inside,
 * on() only watches the signals you specify. All other signal
 * reads inside the callback are untracked.
 *
 * @typeParam T - Tuple type of the dependency values
 *
 * @param deps - An array of signal getters to watch
 * @param fn - Callback receiving current values and previous values.
 *             Runs when any dep changes.
 * @param options - Optional. Set defer: true to skip the initial run.
 *
 * @returns A dispose function to stop watching
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * const [name, setName] = createSignal('Alice');
 *
 * // Only re-runs when count changes, NOT when name changes
 * on([count], ([currentCount], [prevCount]) =>
 * {
 *     console.log(`Count: ${prevCount} → ${currentCount}`);
 *     console.log(`Name: ${name()}`);  // read but NOT tracked
 * });
 * ```
 *
 * @example
 * ```ts
 * // Watch multiple signals
 * on([firstName, lastName], ([first, last]) =>
 * {
 *     console.log(`Full name: ${first} ${last}`);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Defer — skip the initial run
 * on([count], ([val]) =>
 * {
 *     console.log('Changed to:', val);
 * }, { defer: true });
 * // Nothing logged until count actually changes
 * ```
 */
export function on<T extends readonly Getter<unknown>[]>(
    deps: [...T],
    fn: (
        values: { [K in keyof T]: T[K] extends Getter<infer V> ? V : never },
        prevValues: { [K in keyof T]: T[K] extends Getter<infer V> ? V : never },
    ) => void,
    options?: { defer?: boolean },
): DisposeFn
{
    type Values = { [K in keyof T]: T[K] extends Getter<infer V> ? V : never };

    let prevValues: Values = deps.map(() => undefined) as unknown as Values;
    let isFirst = true;

    return createEffect(() =>
    {
        // Read ALL deps — this subscribes the effect to them
        const currentValues = deps.map(dep => dep()) as unknown as Values;

        // Run the callback in untrack so any signal reads inside it
        // don't create additional subscriptions
        if (isFirst && options?.defer)
        {
            isFirst = false;
            prevValues = currentValues;
            return;
        }

        const prev = prevValues;
        prevValues = currentValues;

        untrack(() =>
        {
            fn(currentValues, prev);
        });

        isFirst = false;
    });
}
