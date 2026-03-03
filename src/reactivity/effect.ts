// ============================================================================
// QUANTUM FRAMEWORK — Effect (Reactive Side Effects)
// ============================================================================
//
// An effect is a function that re-runs whenever the signals
// it reads change. Effects are the bridge between reactive
// state and the outside world (DOM updates, console logs,
// network requests, etc.).
//
// LIFECYCLE OF AN EFFECT:
//
//   1. createEffect(fn) is called
//   2. fn runs immediately
//   3. During fn, any signal.getter() calls subscribe this effect
//   4. Each subscription adds a cleanup function to dependencies
//   5. When a subscribed signal changes → effect re-runs:
//      a. Previous cleanup function runs (if any)
//      b. All dependency cleanups run (unsubscribe from signals)
//      c. dependencies set is cleared
//      d. fn runs again → re-subscribes to signals it reads
//   6. When dispose() is called → same cleanup, no re-run
//
// WHY RE-SUBSCRIBE EVERY RUN?
//
//   Because dependencies can CHANGE between runs:
//
//     createEffect(() =>
//     {
//         if (showDetails())
//         {
//             console.log(details());  // subscribes to details
//         }
//         else
//         {
//             console.log(summary());  // subscribes to summary
//         }
//     });
//
//   When showDetails changes:
//     - Old: subscribed to showDetails + details
//     - New: subscribed to showDetails + summary
//     - Must UNSUBSCRIBE from details, SUBSCRIBE to summary
//
//   By clearing all dependencies and re-subscribing each run,
//   we always have the correct subscriptions.
//
// ============================================================================

import type { EffectFn, DisposeFn, CleanupFn, Subscriber, EffectOptions } from './types.ts';
import { currentSubscriber, setCurrentSubscriber } from './signal.ts';
import { isBatching, queueEffect } from './batch.ts';

/**
 * Creates a reactive effect that re-runs whenever its
 * signal dependencies change.
 *
 * The effect function runs immediately upon creation, and
 * then re-runs whenever any signal it reads changes.
 *
 * Returns a dispose function that stops the effect and
 * cleans up all subscriptions.
 *
 * @param fn - The effect function. Can optionally return a
 *             cleanup function that runs before re-execution
 *             or on dispose.
 * @param _options - Optional configuration (name for debugging)
 *
 * @returns A dispose function that stops and cleans up the effect
 *
 * @example
 * ```ts
 * // Basic effect
 * const [count, setCount] = createSignal(0);
 *
 * const dispose = createEffect(() =>
 * {
 *     console.log('Count:', count());
 * });
 * // Logs: "Count: 0" immediately
 *
 * setCount(5);
 * // Logs: "Count: 5"
 *
 * dispose();
 * setCount(10);
 * // Nothing logged — effect is disposed
 * ```
 *
 * @example
 * ```ts
 * // Effect with cleanup
 * const dispose = createEffect(() =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Dynamic dependencies
 * createEffect(() =>
 * {
 *     if (showDetails())
 *     {
 *         console.log(details());  // only subscribes when showing
 *     }
 * });
 * ```
 */
export function createEffect(fn: EffectFn, _options?: EffectOptions): DisposeFn
{
    let cleanup: CleanupFn | void;

    const subscriber: Subscriber =
    {
        execute: runEffect,
        isDisposed: false,
        dependencies: new Set()
    };

    function runEffect(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        // If inside a batch, queue for later
        if (isBatching())
        {
            queueEffect(subscriber);
            return;
        }

        // Step 1: Run previous cleanup (if any)
        if (cleanup)
        {
            cleanup();
            cleanup = undefined;
        }

        // Step 2: Unsubscribe from all current dependencies
        // This prevents stale subscriptions when the effect
        // reads different signals on different runs
        cleanupDependencies(subscriber);

        // Step 3: Set this subscriber as current
        // Save previous for nested effect support
        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(subscriber);

        // Step 4: Run the effect function
        // During this call, every signal.getter() will:
        //   a. Add this subscriber to its subscribers Set
        //   b. Add a cleanup function to subscriber.dependencies
        try
        {
            cleanup = fn() ?? undefined;
        }
        finally
        {
            // Step 5: Restore the previous subscriber
            // (supports nested effects)
            setCurrentSubscriber(previousSubscriber);
        }
    }

    runEffect();

    function dispose(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        subscriber.isDisposed = true;

        // Run final cleanup
        if (cleanup)
        {
            cleanup();
            cleanup = undefined;
        }

        // Unsubscribe from ALL signals — prevents memory leaks
        cleanupDependencies(subscriber);
    }

    return dispose;
}

/**
 * Removes a subscriber from all signals it's subscribed to
 * and clears the dependencies set.
 *
 * This is the KEY function that prevents memory leaks.
 * Each dependency cleanup function removes the subscriber
 * from one signal's subscriber Set.
 *
 * @param subscriber - The subscriber to clean up
 *
 * @internal
 */
function cleanupDependencies(subscriber: Subscriber): void
{
    for (const unsubscribe of subscriber.dependencies)
    {
        unsubscribe();
    }

    subscriber.dependencies.clear();
}
