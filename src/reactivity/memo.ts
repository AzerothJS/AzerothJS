// ============================================================================
// QUANTUM FRAMEWORK — Memo (Computed/Derived Values)
// ============================================================================
//
// A memo creates a cached, derived reactive value. It combines a signal
// (to store the result) with an effect (to recompute when dependencies
// change). The result is a read-only getter that always returns the
// latest computed value.
//
// This file exports:
//   - createMemo() — Creates a memoized computed value
//
// HOW IT WORKS:
//
//   createMemo(() => price() + tax())
//         │
//         ├── Creates an INTERNAL signal to store the result
//         └── Creates an INTERNAL effect that:
//               1. Runs the computation function
//               2. Stores the result in the internal signal
//               3. Re-runs when price or tax change
//
//   The returned getter reads from the internal signal,
//   which means other effects can subscribe to the memo too!
//
// CHAIN EXAMPLE:
//
//   const [price, setPrice] = createSignal(100);
//   const tax = createMemo(() => price() * 0.2);
//   const total = createMemo(() => price() + tax());
//
//   setPrice(200)
//     → price's subscribers notified
//     → tax's effect re-runs → tax signal updates to 40
//     → total's effect re-runs → total signal updates to 240
//     → any effect reading total() also re-runs!
//
// ============================================================================

import type { Getter, SignalOptions } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';

/**
 * Creates a memoized (cached) reactive value derived from other signals.
 *
 * A memo is read-only — you can read it like a signal, but you cannot
 * set its value directly. Its value is always the result of the
 * computation function, which re-runs when any signal it reads changes.
 *
 * Memos are useful for:
 *   - Derived calculations (total = price + tax)
 *   - Expensive computations that should only re-run when inputs change
 *   - Creating a reactive value that depends on other reactive values
 *   - Avoiding redundant computations across multiple effects
 *
 * @typeParam T - The type of the computed value.
 *               Inferred from the return type of the computation function.
 *
 * @param fn - The computation function. Reads one or more signals and
 *             returns a derived value. Re-runs when dependencies change.
 * @param options - Optional signal options (custom equality, debug name)
 *                  applied to the internal signal that stores the result.
 *
 * @returns A {@link Getter} that returns the current computed value.
 *          Note: only a getter is returned, NOT a setter — memos are
 *          read-only because their value is computed, not set manually.
 *
 * @example
 * ```ts
 * // Basic computed value
 * const [count, setCount] = createSignal(2);
 * const doubled = createMemo(() => count() * 2);
 *
 * console.log(doubled());  // 4
 * setCount(5);
 * console.log(doubled());  // 10
 * ```
 *
 * @example
 * ```ts
 * // Chaining memos — each one reacts to the one before it
 * const [price, setPrice] = createSignal(100);
 * const tax = createMemo(() => price() * 0.2);
 * const total = createMemo(() => price() + tax());
 *
 * console.log(total());  // 120
 * setPrice(200);
 * console.log(total());  // 240
 * ```
 *
 * @example
 * ```ts
 * // Using inside effects — the effect re-runs when the memo updates
 * const [items, setItems] = createSignal([1, 2, 3]);
 * const sum = createMemo(() => items().reduce((a, b) => a + b, 0));
 *
 * createEffect(() =>
 * {
 *     console.log('Sum is:', sum());  // Re-runs when sum changes
 * });
 * ```
 */
export function createMemo<T>(fn: () => T, options?: SignalOptions<T>): Getter<T>
{
    const [memo, setMemo] = createSignal<T>(undefined as T, options);

    createEffect(() =>
    {
        setMemo(() => fn());
    });

    return memo;
}
