// ============================================================================
// QUANTUM FRAMEWORK — Memo (Computed Values)
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

import type { Getter, SignalOptions } from './types.ts';
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
    // Create an internal signal to store the computed value
    // This makes the memo act as a signal that others can subscribe to
    const [value, setValue] = createSignal<T>(undefined as unknown as T, options);

    // Create an effect that recomputes when dependencies change
    // The effect subscribes to whatever signals compute() reads
    createEffect(() =>
    {
        setValue(compute());
    });

    return value;
}
