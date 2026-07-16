/**
 * MODULE: reactivity/on
 *
 * on() builds an effect with an EXPLICIT dependency list instead of automatic
 * tracking. A plain createEffect subscribes to every source it reads; on([a, b], fn)
 * subscribes only to a and b, leaving the callback free to read other sources without
 * subscribing to them. The callback also receives the previous values alongside the
 * current ones, so it can react to a specific transition rather than mere occurrence.
 */

import type { Getter, DisposeFn } from './types.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';
import { assertFunction, describeArg } from './validate.ts';

/** Options for {@link on} (and the `effect (deps) with { ... }` keyword form). */
export interface OnOptions
{
    /**
     * Skip the initial run: the first dependency read only records baseline values, and `fn`
     * first runs on the NEXT change (with genuine previous values). Default false - `fn` runs
     * once immediately, like a plain effect.
     */
    skipInitial?: boolean;
}

/**
 * on
 *
 * PURPOSE:
 * Creates an effect that watches exactly the getters in `deps`. When any of them
 * changes, `fn` runs with the current values and the previous values; every other
 * reactive read inside `fn` is untracked.
 *
 * WHY IT EXISTS:
 * Automatic tracking is the right default, but two needs fall outside it: watching a
 * precise set of sources while reading others incidentally, and seeing the prior
 * value of a source (auto-tracking gives neither). on() provides both without the
 * caller hand-rolling untrack() around every incidental read.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. A thin, explicit-dependency wrapper over createEffect;
 * not produced by the compiler directly - it is an authoring convenience.
 *
 * INPUT CONTRACT:
 * - deps: a tuple of getters; only these are subscribed (read each run to track them).
 * - fn: receives (values, prevValues) as tuples parallel to deps. prevValues entries
 *   are `V | undefined` because the first run has no prior value.
 * - options.skipInitial: when true, the initial run only records baseline values and does
 *   not call fn; fn first runs on the next change.
 *
 * OUTPUT CONTRACT:
 * - Returns the underlying effect's dispose function.
 *
 * WHY THIS DESIGN:
 * deps are read at the top of the effect (that read IS the subscription), then fn runs
 * inside untrack() so its own reads add no further dependencies. Previous values are
 * carried in a closure and rotated each run; typing them `V | undefined` forces
 * callers to handle the first-run case rather than crashing on `prev.x`.
 *
 * WHEN TO USE:
 * When an effect should fire on a specific set of sources, or needs the prior value of
 * a source to compute a delta/transition.
 *
 * WHEN NOT TO USE:
 * When ordinary auto-tracking is sufficient - a plain createEffect is simpler and has
 * no closure overhead for previous values.
 *
 * EDGE CASES:
 * - With `skipInitial: true` the first invocation of fn already has genuine previous values,
 *   but the type stays `V | undefined` to remain conservative.
 * - Reading a dep conditionally inside fn does not change what is watched; the watched
 *   set is fixed by `deps`, which is always read in full at the top.
 *
 * PERFORMANCE NOTES:
 * One array allocation per run for the current values (and the previous-value rotation).
 * Subscriptions are limited to `deps`, so unrelated source churn never re-runs it.
 *
 * DEVELOPER WARNING:
 * Only `deps` are tracked - if fn relies on a source not listed in deps, it will read a
 * stale value and never re-run for it. Dispose it like any effect to avoid leaks.
 *
 * @typeParam T - Tuple type of the dependency getters.
 * @param deps - The getters to watch.
 * @param fn - Runs on any dep change, receiving current and previous value tuples.
 * @param options - Set `skipInitial: true` to skip the initial run.
 * @returns A dispose function that stops watching.
 * @see {@link createEffect}
 * @see {@link untrack}
 * @example
 * const [count, setCount] = createSignal(0);
 * on([count], ([cur], [prev]) => console.log(`${ prev } -> ${ cur }`));
 * on([count], ([v]) => console.log('changed to', v), { skipInitial: true });
 */
export function on<T extends readonly Getter<unknown>[]>(
    deps: [...T],
    fn: (
        values: { [K in keyof T]: T[K] extends Getter<infer V> ? V : never },
        prevValues: { [K in keyof T]: T[K] extends Getter<infer V> ? V | undefined : never }
    ) => void,
    options?: OnOptions
): DisposeFn
{
    if (!Array.isArray(deps))
    {
        throw new TypeError(
            `on() expects an array of dependency getters as its first argument, received ${ describeArg(deps) }. ` +
            'Wrap a single source too: on([count], ...).'
        );
    }
    assertFunction(fn, 'on', 'Pass the callback as a function: on([dep], (values, prev) => { ... }).');

    type Values = { [K in keyof T]: T[K] extends Getter<infer V> ? V : never };

    // Previous values are undefined on the first run (no prior value yet), so they are
    // typed `V | undefined` to force callers to handle that case.
    type PrevValues = { [K in keyof T]: T[K] extends Getter<infer V> ? V | undefined : never };

    let prevValues: PrevValues = deps.map(() => undefined) as unknown as PrevValues;
    let isFirst = true;

    return createEffect(() =>
    {
        // Reading every dep here is what subscribes the effect to them.
        const currentValues = deps.map(dep => dep()) as unknown as Values;

        if (isFirst && options?.skipInitial)
        {
            isFirst = false;
            prevValues = currentValues;
            return;
        }

        const prev = prevValues;
        prevValues = currentValues;

        // Run the callback untracked so its own reads add no subscriptions beyond deps.
        untrack(() =>
        {
            fn(currentValues, prev);
        });

        isFirst = false;
    });
}
