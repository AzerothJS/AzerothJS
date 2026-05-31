// ============================================================================
// AZEROTHJS — Memo (Computed Values)
// ============================================================================
//
// A memo is a computed value that caches its result and only
// recomputes when its signal dependencies change.
//
// It's both a CONSUMER (reads signals) and a PRODUCER (other
// effects can subscribe to it like a signal).
//
// HOW IT WORKS:
//
//   const total = createMemo(() => price() * quantity());
//
//   Internally:
//     1. Creates a signal to store the computed value
//     2. Creates an effect that recomputes and updates the signal
//     3. Returns just the signal's getter
//
//   When price or quantity changes:
//     → The internal effect re-runs
//     → The internal signal is updated
//     → Any effects subscribed to total() are notified
//
// ============================================================================

import type { Getter, SignalOptions, EqualsFn } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';

/**
 * Creates a memoized computed value that only recalculates
 * when its dependencies change.
 *
 * The compute function runs immediately and whenever any
 * signal it reads changes. The result is cached — reading
 * the memo multiple times without dependency changes returns
 * the cached value without recomputing.
 *
 * Other effects can subscribe to the memo by calling the
 * returned getter inside their effect function.
 *
 * @typeParam T - The type of the computed value
 *
 * @param compute - A function that computes the value from signals
 * @param options - Optional configuration (custom equality)
 *
 * @returns A getter function that returns the cached computed value
 *
 * @example
 * ```ts
 * // Basic memo
 * const [price, setPrice] = createSignal(100);
 * const [quantity, setQuantity] = createSignal(2);
 * const total = createMemo(() => price() * quantity());
 *
 * total();  // → 200
 * setPrice(50);
 * total();  // → 100 (recomputed)
 * ```
 *
 * @example
 * ```ts
 * // Memo as dependency for effects
 * const [items, setItems] = createSignal([1, 2, 3]);
 * const count = createMemo(() => items().length);
 * const isEmpty = createMemo(() => count() === 0);
 *
 * createEffect(() =>
 * {
 *     console.log(`${ count() } items, empty: ${ isEmpty() }`);
 * });
 * // Logs: "3 items, empty: false"
 * ```
 *
 * @example
 * ```ts
 * // Memo with custom equality
 * const [price, setPrice] = createSignal(9.99);
 * const rounded = createMemo(() => Math.round(price()), { equals: (a, b) => a === b });
 * ```
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    // Equality used to decide whether a recomputation actually
    // changed the value. We gate updates MANUALLY (below) instead
    // of letting the backing signal do it, for two reasons:
    //
    //   1. The custom `equals` must never see the initial
    //      placeholder. A memo's FIRST computed value is always
    //      accepted. If the signal gated instead, it would call
    //      `equals(undefined, firstValue)` — which crashes for any
    //      `equals` that dereferences its arguments, e.g.
    //      `(a, b) => a.id === b.id`.
    //
    //   2. We store the value through a function updater (see
    //      below), so the backing signal can't gate it anyway.
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    // Internal signal that consumers subscribe to — this is what
    // makes the memo act like a signal others can read. It's told
    // to ALWAYS notify (`equals: () => false`) because this memo
    // owns the equality decision: by the time we call `setValue`,
    // we've already confirmed the value changed.
    const [value, setValue] = createSignal<T>(undefined as unknown as T, { equals: () => false });

    // Tracks whether the first computation has run, so the initial
    // value can bypass the equality check.
    let hasValue = false;
    let current: T;

    // Recompute whenever a dependency changes. Runs synchronously
    // on creation, so the memo holds its real value before
    // createMemo returns (unless created inside a batch, where the
    // first run is deferred to the flush — ordinary effect timing).
    createEffect(() =>
    {
        const next = compute();

        // First value is always accepted; afterwards only propagate
        // when the value actually changed under `equals`.
        if (hasValue && equals(current, next))
        {
            return;
        }

        current = next;
        hasValue = true;

        // Store via a function updater so the value is written
        // verbatim even when T is itself a function. A plain
        // `setValue(next)` would treat a function `next` as an
        // updater and invoke it — corrupting function-valued memos.
        setValue(() => next);
    });

    return value;
}
