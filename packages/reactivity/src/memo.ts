// A memo is a computed value that caches its result and only recomputes when
// its signal dependencies change. It is both a consumer (reads signals) and a
// producer (other effects can subscribe to it like a signal).
//
// Internally it pairs a signal that stores the computed value with an effect
// that recomputes and writes that signal, then returns only the signal's
// getter. When a dependency changes the effect re-runs, updates the signal,
// and any effects reading the memo are notified.

import type { Getter, SignalOptions, EqualsFn } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';

/**
 * Creates a memoized computed value that recalculates only when its
 * dependencies change. The compute function runs immediately and whenever a
 * signal it reads changes; reads in between return the cached value. Other
 * effects can depend on the memo by calling the returned getter.
 *
 * @typeParam T - The type of the computed value
 *
 * @param compute - Computes the value from signals
 * @param options - Optional custom equality
 *
 * @returns A getter that returns the cached computed value
 *
 * Why: a plain compute function reruns its full body on every read and forces
 * each reader to subscribe to all the sources.
 *
 * Without createMemo: a bare function recomputes every time it is called:
 *
 *     const total = () => price() * quantity();
 *     total();
 *     total(); // multiplies again even though nothing changed
 *
 * With createMemo: the result is cached until a dependency actually changes:
 *
 *     const total = createMemo(() => price() * quantity());
 *     total();
 *     total(); // returns the cached value, no recompute
 *
 * @example
 * ```ts
 * const [price, setPrice] = createSignal(100);
 * const [quantity] = createSignal(2);
 * const total = createMemo(() => price() * quantity());
 *
 * total();        // 200
 * setPrice(50);
 * total();        // 100 (recomputed)
 * ```
 *
 * @example
 * ```ts
 * // Memos compose as dependencies of other memos and effects
 * const count = createMemo(() => items().length);
 * const isEmpty = createMemo(() => count() === 0);
 * ```
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    // Decides whether a recomputation actually changed the value. We gate
    // updates manually (below) rather than letting the backing signal do it,
    // for two reasons:
    //
    //   1. The custom `equals` must never see the initial placeholder. A
    //      memo's first computed value is always accepted; if the signal
    //      gated, it would call `equals(undefined, firstValue)`, which
    //      crashes any `equals` that dereferences its arguments, e.g.
    //      `(a, b) => a.id === b.id`.
    //   2. We store the value through a function updater (see below), so the
    //      backing signal can't gate it anyway.
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    // The signal consumers subscribe to - this is what lets the memo act like
    // a signal others can read. It always notifies (`equals: () => false`)
    // because this memo owns the equality decision: by the time we call
    // setValue we have already confirmed the value changed.
    const [value, setValue] = createSignal<T>(undefined as unknown as T, { equals: () => false });

    // hasValue lets the first computed value bypass the equality check.
    let hasValue = false;
    let current: T;

    // Recompute whenever a dependency changes. Runs synchronously on creation,
    // so the memo holds its real value before createMemo returns - unless
    // created inside a batch, where the first run defers to the flush like any
    // other effect.
    createEffect(() =>
    {
        const next = compute();

        // First value is always accepted; after that, propagate only when the
        // value actually changed under `equals`.
        if (hasValue && equals(current, next))
        {
            return;
        }

        current = next;
        hasValue = true;

        // Store via a function updater so the value is written verbatim even
        // when T is itself a function. A plain `setValue(next)` would treat a
        // function `next` as an updater and invoke it, corrupting
        // function-valued memos.
        setValue(() => next);
    });

    return value;
}
