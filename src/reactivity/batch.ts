// ============================================================================
// QUANTUM FRAMEWORK — Batch (Grouped Updates)
// ============================================================================
//
// Batch allows multiple signal updates to be grouped together,
// deferring effect execution until all updates are complete.
//
// Without batch:
//   setFirstName('John');   → effect runs (unnecessary!)
//   setLastName('Doe');     → effect runs (with correct values)
//
// With batch:
//   batch(() =>
//   {
//       setFirstName('John'); → queued
//       setLastName('Doe');   → queued
//   });                     → effects run ONCE with both values correct
//
// ============================================================================

import type { Subscriber } from './types.ts';

/**
 * Whether we're currently inside a batch() call.
 * When true, effects are queued instead of running immediately.
 *
 * @internal
 */
let batching = false;

/**
 * The queue of effects waiting to run after the batch completes.
 * Uses a Set to automatically deduplicate — if the same effect
 * is triggered multiple times during a batch, it only runs once.
 *
 * @internal
 */
const queue = new Set<Subscriber>();

/**
 * Returns whether we're currently inside a batch.
 *
 * Used by createEffect to decide whether to run immediately
 * or queue for later.
 *
 * @internal
 * @returns true if inside a batch() call
 */
export function isBatching(): boolean
{
    return batching;
}

/**
 * Adds an effect to the batch queue.
 *
 * Called by effect's execute function when isBatching() is true.
 * The effect will run after the batch() call completes.
 *
 * @internal
 * @param subscriber - The subscriber to queue
 */
export function queueEffect(subscriber: Subscriber): void
{
    queue.add(subscriber);
}

/**
 * Groups multiple signal updates together, deferring effect
 * execution until all updates are complete.
 *
 * @param fn - A function containing multiple signal updates
 *
 * @example
 * ```ts
 * const [first, setFirst] = createSignal('Jane');
 * const [last, setLast] = createSignal('Smith');
 *
 * createEffect(() =>
 * {
 *     console.log(`${first()} ${last()}`);
 * });
 * // Logs: "Jane Smith"
 *
 * batch(() =>
 * {
 *     setFirst('John');
 *     setLast('Doe');
 * });
 * // Logs: "John Doe" (only ONCE, not twice)
 * ```
 */
export function batch(fn: () => void): void
{
    // If already batching (nested batch), just run the function
    if (batching)
    {
        fn();
        return;
    }

    batching = true;

    try
    {
        fn();
    }
    finally
    {
        batching = false;

        // Flush the queue — run all queued effects
        // Use a copy because effects might trigger new signals
        // which queue more effects
        const effects = Array.from(queue);
        queue.clear();

        for (const subscriber of effects)
        {
            if (!subscriber.isDisposed)
            {
                subscriber.execute();
            }
        }
    }
}
