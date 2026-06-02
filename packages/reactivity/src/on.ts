// on() creates an effect that explicitly declares which signals it depends on
// instead of auto-tracking. A plain createEffect subscribes to everything it
// reads; on([a, b], ...) subscribes only to a and b, so the callback can read
// other signals freely without subscribing to them.
//
// The callback also receives the previous values alongside the current ones,
// which is handy for reacting to a specific change rather than just its
// occurrence.

import type { Getter, DisposeFn } from './types.ts';
import { createEffect } from './effect.ts';
import { untrack } from './untrack.ts';

/**
 * Creates an effect with explicit dependency tracking. Only the signals in
 * `deps` are watched; all other signal reads inside the callback are
 * untracked. The callback receives the current values and the previous ones.
 *
 * @typeParam T - Tuple type of the dependency getters
 *
 * @param deps - The signal getters to watch
 * @param fn - Runs when any dep changes, with current and previous values
 * @param options - Set `defer: true` to skip the initial run
 *
 * @returns A dispose function to stop watching
 *
 * Why: a plain effect subscribes to everything it reads and has no handle on
 * the prior value.
 *
 * Without on: every read inside the body becomes a dependency:
 *
 *     createEffect(() =>
 *     {
 *         log(count(), other()); // now re-runs when other() changes too
 *     });
 *
 * With on: only the listed deps are watched, and you get the previous value:
 *
 *     on([count], ([cur], [prev]) =>
 *     {
 *         log(cur, prev, other()); // other() read is untracked, no subscribe
 *     });
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 *
 * on([count], ([current], [prev]) =>
 * {
 *     console.log(`Count: ${ prev } -> ${ current }`);
 * });
 * ```
 *
 * @example
 * ```ts
 * // defer: nothing fires until a dep actually changes
 * on([count], ([val]) => console.log('Changed to:', val), { defer: true });
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

    // Previous values are `undefined` on the first callback run (there is no
    // prior value yet), so they are typed `V | undefined`, forcing callers to
    // handle the first-run case instead of crashing on `prev.something`. With
    // `defer: true` the first real callback already has a genuine previous
    // value, but the type stays conservative.
    type PrevValues = { [K in keyof T]: T[K] extends Getter<infer V> ? V | undefined : never };

    let prevValues: PrevValues = deps.map(() => undefined) as unknown as PrevValues;
    let isFirst = true;

    return createEffect(() =>
    {
        // Reading every dep here is what subscribes the effect to them.
        const currentValues = deps.map(dep => dep()) as unknown as Values;

        if (isFirst && options?.defer)
        {
            isFirst = false;
            prevValues = currentValues;
            return;
        }

        const prev = prevValues;
        prevValues = currentValues;

        // Run the callback untracked so its own signal reads don't add
        // subscriptions beyond the declared deps.
        untrack(() =>
        {
            fn(currentValues, prev);
        });

        isFirst = false;
    });
}
