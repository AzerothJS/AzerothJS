// ============================================================================
// AZEROTHJS — Untrack (Read Without Subscribing)
// ============================================================================
//
// untrack() lets you read a signal's value inside an effect
// WITHOUT subscribing to it. The effect won't re-run when
// untracked signals change.
//
// USE CASES:
//
//   1. Read a signal for logging only:
//      createEffect(() =>
//      {
//          console.log('Count changed:', count());
//          console.log('User:', untrack(() => user()));
//          // Re-runs when count changes, NOT when user changes
//      });
//
//   2. Prevent unnecessary re-runs:
//      createEffect(() =>
//      {
//          const data = fetchData(query());       // subscribe
//          const limit = untrack(() => pageSize()); // don't subscribe
//      });
//
//   3. Prevent infinite loops:
//      createEffect(() =>
//      {
//          const val = count();
//          untrack(() => setOther(val));  // safe, no loop
//      });
//
// ============================================================================

import { currentSubscriber, setCurrentSubscriber } from './signal.ts';

/**
 * Executes a function without tracking any signal reads.
 *
 * Any signals read inside the function will NOT subscribe
 * the current effect. The effect will NOT re-run when those
 * signals change.
 *
 * The subscriber context is properly restored after untrack
 * completes, even if the function throws.
 *
 * @typeParam T - The return type of the function
 *
 * @param fn - The function to run without tracking
 *
 * @returns The return value of the function
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * const [name, setName] = createSignal('Alice');
 *
 * createEffect(() =>
 * {
 *     // Tracked — effect re-runs when count changes
 *     console.log('Count:', count());
 *
 *     // Untracked — changing name does NOT re-run this effect
 *     const currentName = untrack(() => name());
 *     console.log('Name:', currentName);
 * });
 *
 * setCount(1);   // Effect re-runs ✅
 * setName('Bob'); // Effect does NOT re-run ✅
 * ```
 *
 * @example
 * ```ts
 * // Nested untrack — all reads are untracked
 * createEffect(() =>
 * {
 *   const result = untrack(() =>
 *   {
 *       return a() + untrack(() => b());
 *   });
 *   // Effect is subscribed to NOTHING — won't re-run
 * });
 * ```
 *
 * @example
 * ```ts
 * // Context restored after untrack
 * createEffect(() =>
 * {
 *     const aVal = a();                     // tracked
 *     const bVal = untrack(() => b());      // NOT tracked
 *     const cVal = c();                     // tracked (restored)
 * });
 * ```
 */
export function untrack<T>(fn: () => T): T
{
    // Save the current subscriber
    const previousSubscriber = currentSubscriber;

    // Clear it — signals read inside fn won't see any subscriber
    setCurrentSubscriber(null);

    try
    {
        return fn();
    }
    finally
    {
        // Restore the subscriber
        setCurrentSubscriber(previousSubscriber);
    }
}
