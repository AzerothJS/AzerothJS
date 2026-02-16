// ============================================================================
// QUANTUM FRAMEWORK — Untrack (Read Without Subscribing)
// ============================================================================
//
// untrack() lets you read a signal's value inside an effect
// WITHOUT subscribing to it. The effect won't re-run when
// untracked signals change.
//
// USE CASES:
//
//   1. Reading a signal for logging only:
//      createEffect(() =>
//      {
//          console.log('Count changed:', count());
//          console.log('Current user:', untrack(() => user()));
//          // Re-runs when count changes, NOT when user changes
//      });
//
//   2. Conditional reads where you don't want dependency:
//      createEffect(() =>
//      {
//          const data = fetchData(query());  // subscribe to query
//          const limit = untrack(() => pageSize());  // DON'T subscribe
//      });
//
//   3. Preventing infinite loops:
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
 *     // This effect subscribes to count
 *     console.log('Count:', count());
 *
 *     // This read is untracked — changing name won't re-run this effect
 *     const currentName = untrack(() => name());
 *     console.log('Name (untracked):', currentName);
 * });
 *
 * setCount(1);  // Effect re-runs ✅
 * setName('Bob'); // Effect does NOT re-run ✅
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
