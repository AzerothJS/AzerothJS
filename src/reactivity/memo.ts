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
// ============================================================================

import type { Getter, SignalOptions } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';

/**
 * Creates a memoized computed value that only recalculates
 * when its dependencies change.
 *
 * @typeParam T - The type of the computed value
 *
 * @param compute - A function that computes the value from signals
 * @param options - Optional configuration (custom equality function)
 *
 * @returns A getter function that returns the cached computed value
 *
 * @example
 * ```ts
 * const [price, setPrice] = createSignal(100);
 * const [quantity, setQuantity] = createSignal(2);
 * const total = createMemo(() => price() * quantity());
 *
 * total();  // → 200
 *
 * setPrice(50);
 * total();  // → 100 (recomputed)
 *
 * // Reading total() in an effect subscribes to it
 * createEffect(() =>
 * {
 *     console.log('Total:', total());
 * });
 * ```
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    const [value, setValue] = createSignal<T>(undefined as unknown as T, options);

    createEffect(() =>
    {
        setValue(compute());
    });

    return value;
}
