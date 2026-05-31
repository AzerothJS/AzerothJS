// ============================================================================
// AZEROTHJS — on() (Explicit Dependency Tracking)
// ============================================================================
//
// on() creates an effect that explicitly declares which signals
// it depends on, instead of auto-tracking.
//
// WHY?
//
//   createEffect(() =>
//   {
//       // Auto-tracks EVERYTHING read inside
//       console.log(a(), b(), c(), d(), e());
//   });
//
//   on([a, b], ([aVal, bVal]) =>
//   {
//       // Only tracks a and b
//       // c, d, e can be read freely without subscribing
//       console.log(aVal, bVal, c(), d(), e());
//   });
//
// PREVIOUS VALUES:
//
//   on() provides both current and previous values to the
//   callback. This is useful for comparing changes:
//
//   on([count], ([current], [previous]) =>
//   {
//       console.log(`Changed from ${ previous } to ${ current }`);
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
 * Provides both current and previous values to the callback.
 *
 * @typeParam T - Tuple type of the dependency getters
 *
 * @param deps - An array of signal getters to watch
 * @param fn - Callback receiving current and previous values.
 *             Runs when any dep changes.
 * @param options - Optional. Set defer: true to skip initial run.
 *
 * @returns A dispose function to stop watching
 *
 * @example
 * ```ts
 * // Watch a single signal
 * const [count, setCount] = createSignal(0);
 *
 * on([count], ([currentCount], [prevCount]) =>
 * {
 *     console.log(`Count: ${ prevCount } → ${ currentCount }`);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Watch multiple signals
 * const [firstName, setFirst] = createSignal('John');
 * const [lastName, setLast] = createSignal('Doe');
 *
 * on([firstName, lastName], ([first, last]) =>
 * {
 *     console.log(`Full name: ${ first } ${ last }`);
 *     // Reading other signals here is NOT tracked
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
 *
 * @example
 * ```ts
 * // Dispose — stop watching
 * const dispose = on([count], ([val]) =>
 * {
 *     console.log(val);
 * });
 *
 * dispose();  // Stops watching
 * ```
 */
export function on<T extends readonly Getter<unknown>[]>(
    deps: [...T],
    fn: (
        values: { [K in keyof T]: T[K] extends Getter<infer V> ? V : never },
        prevValues: { [K in keyof T]: T[K] extends Getter<infer V> ? V | undefined : never }
    ) => void,
    options?: { defer?: boolean }
): DisposeFn
{
    type Values = { [K in keyof T]: T[K] extends Getter<infer V> ? V : never };

    // Previous values are `undefined` on the FIRST callback run
    // (there is no prior value yet), so they're typed as
    // `V | undefined` — this forces callers to handle the
    // first-run case instead of crashing on `prev.something`.
    // (With `defer: true` the first real callback already has a
    // genuine previous value, but the type stays conservative.)
    type PrevValues = { [K in keyof T]: T[K] extends Getter<infer V> ? V | undefined : never };

    let prevValues: PrevValues = deps.map(() => undefined) as unknown as PrevValues;
    let isFirst = true;

    return createEffect(() =>
    {
        // Read ALL deps — this subscribes the effect to them
        const currentValues = deps.map(dep => dep()) as unknown as Values;

        // Defer: skip the initial run if requested
        if (isFirst && options?.defer)
        {
            isFirst = false;
            prevValues = currentValues;
            return;
        }

        const prev = prevValues;
        prevValues = currentValues;

        // Run the callback in untrack so any signal reads
        // inside it don't create additional subscriptions
        untrack(() =>
        {
            fn(currentValues, prev);
        });

        isFirst = false;
    });
}
