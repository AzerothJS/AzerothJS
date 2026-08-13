/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * An effect with an explicit dependency list instead of automatic tracking, whose callback
 * also receives the previous values, so it can react to a transition rather than to the
 * mere fact that something changed.
 */

import type { Getter, DisposeFn } from './types.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';
import { assertFunction, describeArg } from './validate.ts';

/** Options for {@link on}, and for the `effect (deps) with { ... }` keyword form. */
export interface OnOptions
{
    /**
     * Skip the initial run: the first pass only records baseline values, and `fn` first runs
     * on the NEXT change, with genuine previous values. Defaults to false, so `fn` runs once
     * immediately like a plain effect.
     */
    skipInitial?: boolean;

    /** Debug name for the underlying effect, surfaced by devtools and error tooling. */
    name?: string | undefined;
}

/**
 * Creates an effect that watches exactly the getters in `deps` and nothing else. Every
 * reactive read inside `fn` is untracked, so the callback can consult other state freely
 * without subscribing to it.
 *
 * The watched set is fixed by `deps`, which is read in full at the top of every run.
 * Reading a dependency conditionally inside `fn` changes nothing about what is watched -
 * and a source `fn` needs but `deps` omits will be read stale and never re-run the effect.
 *
 * `fn` receives two tuples parallel to `deps`: the current values, and the previous ones.
 * Previous entries are typed `V | undefined` because the first run has no prior value; the
 * type stays conservative even under `skipInitial`, where the first call does have real
 * previous values.
 *
 * @typeParam T - Tuple type of the dependency getters.
 * @param deps - The getters to watch. Wrap a single source too: `on([count], ...)`.
 * @param fn - Runs on any change, receiving `(values, previousValues)`.
 * @param options - Optional settings.
 * @param options.skipInitial - Skip the first run and start from the next change.
 * @param options.name - Debug name for the underlying effect.
 * @returns The underlying effect's disposer.
 * @throws {TypeError} If `deps` is not an array, or `fn` is not a function.
 * @example
 * const [count, setCount] = createSignal(0);
 *
 * on([count], ([current], [previous]) => log(`${ previous } -> ${ current }`));
 *
 * // React only to later changes:
 * on([count], ([value]) => save(value), { skipInitial: true });
 *
 * @see {@link createEffect} when automatic tracking is enough.
 * @see {@link untrack}
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

        // Untracked, so the callback's own reads add no subscriptions beyond deps.
        untrack(() =>
        {
            fn(currentValues, prev);
        });

        isFirst = false;
    }, { name: options?.name });
}
