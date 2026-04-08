// ============================================================================
// AZEROTHJS — Batch (Grouped Updates)
// ============================================================================
//
// Batch allows multiple signal updates to be grouped together,
// deferring effect execution until all updates are complete.
//
// WITHOUT batch:
//   setFirstName('John');   → effect runs (unnecessary!)
//   setLastName('Doe');     → effect runs (with correct values)
//   Result: effect ran TWICE
//
// WITH batch:
//   batch(() =>
//   {
//       setFirstName('John'); → queued
//       setLastName('Doe');   → queued
//   });                     → effects run ONCE
//   Result: effect ran ONCE with both values correct
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
 * Queue of effects waiting to run after the batch completes.
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
 * @returns true if inside a batch() call
 *
 * @internal
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
 * @param subscriber - The subscriber to queue
 *
 * @internal
 */
export function queueEffect(subscriber: Subscriber): void
{
    queue.add(subscriber);
}

/**
 * Groups multiple signal updates together, deferring effect
 * execution until all updates are complete.
 *
 * Effects only run once after the batch, even if their
 * dependencies were updated multiple times.
 *
 * Supports nesting — inner batch() calls just run their
 * function, only the outermost batch flushes effects.
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
 *     console.log(`${ first() } ${ last() }`);
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
 *
 * @example
 * ```ts
 * // Nested batches — only outermost flushes
 * batch(() =>
 * {
 *     setA(1);
 *     batch(() =>
 *     {
 *         setB(2);
 *         setC(3);
 *     });
 *     setD(4);
 * });
 * // All effects run once after the outer batch completes
 * ```
 */
export function batch(fn: () => void): void
{
    // If already batching (nested), just run the function
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
        // Copy because effects might trigger new signals
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
