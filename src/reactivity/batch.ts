// ============================================================================
// QUANTUM FRAMEWORK — Batch (Grouped Updates)
// ============================================================================
//
// Batching groups multiple signal updates into a single reaction cycle.
// Without batching, each signal.write() immediately notifies subscribers.
// With batching, notifications are deferred until the batch completes,
// then all unique subscribers are called exactly once.
//
// This file exports:
//   - batch()           — Groups multiple updates into one reaction
//   - getIsBatching()   — Checks if currently inside a batch (internal)
//   - enqueueEffect()   — Adds an effect to the batch queue (internal)
//
// HOW IT WORKS:
//
//   batch(() =>
//   {
//       setA(1);   // signal.write() sees isBatching=true → queues effect
//       setB(2);   // signal.write() sees isBatching=true → queues effect
//       setC(3);   // signal.write() sees isBatching=true → queues effect
//   });
//   // batch ends → flush queue → each unique effect runs once
//
// WHY A SET FOR THE QUEUE:
//
//   If setA and setB both trigger the SAME effect, that effect
//   should only run ONCE after the batch. Using a Set guarantees
//   no duplicates — the effect is queued once, runs once.
//
// ============================================================================

import type { Subscriber } from './types.ts';

// ============================================================================
// INTERNAL STATE
// ============================================================================

/**
 * Whether we are currently inside a batch() call.
 *
 * When true, signal.write() will queue effects instead of running
 * them immediately. When false, effects run synchronously on each
 * signal change (the default behavior).
 *
 * @internal Used by signal.ts to decide: run now or queue?
 */
let isBatching = false;

/**
 * Queue of effects waiting to run after the batch completes.
 *
 * - `null` when not batching (no queue needed)
 * - `Set<Subscriber>` when batching (collecting effects to run later)
 *
 * Why null instead of an empty Set:
 *   To clearly distinguish "not batching" from "batching with no effects yet".
 *   When isBatching is false, batchQueue should always be null.
 *
 * Why Set instead of Array:
 *   If two signals both trigger the same effect:
 *     Array: [effectA, effectA] → effectA runs TWICE (wasteful!)
 *     Set:   {effectA}          → effectA runs ONCE  (correct!)
 *
 * @internal Used by signal.ts via enqueueEffect()
 */
let batchQueue: Set<Subscriber> | null = null;

// ============================================================================
// INTERNAL API (used by signal.ts)
// ============================================================================

/**
 * Checks if we are currently inside a batch.
 *
 * Called by signal.ts in the write function to decide whether to
 * run a subscriber immediately or add it to the batch queue.
 *
 * @internal Not exposed to framework users.
 *
 * @returns `true` if inside a batch() call, `false` otherwise
 *
 * @example
 * ```ts
 * // Inside signal.ts write function:
 * for (const subscriber of subscribers)
 * {
 *   if (getIsBatching())
 *   {
 *       enqueueEffect(subscriber);  // Queue it for later
 *   }
 *   else
 *   {
 *       subscriber();               // Run it now
 *   }
 * }
 * ```
 */
export function getIsBatching(): boolean
{
    return isBatching;
}

/**
 * Adds an effect to the batch queue.
 *
 * Called by signal.ts when a signal changes during a batch.
 * Instead of running the effect immediately, it's stored in the
 * queue and will be executed when the batch completes.
 *
 * If the same effect is enqueued multiple times (because multiple
 * signals it depends on changed), the Set ensures it only appears
 * once and will only run once when the batch flushes.
 *
 * @internal Not exposed to framework users.
 *
 * @param effect - The subscriber function to queue
 */
export function enqueueEffect(effect: Subscriber): void
{
    batchQueue?.add(effect);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Batches multiple signal updates into a single reaction cycle.
 *
 * Without batching, each signal setter immediately notifies all
 * subscribers. This can cause unnecessary re-runs and intermediate
 * states. Batching defers all notifications until after every
 * update in the batch has been applied, then runs each affected
 * subscriber exactly once.
 *
 * Nested batch() calls are safe — only the outermost batch
 * triggers the flush. Inner batches simply run their function
 * without creating a new queue.
 *
 * @param fn - A function containing one or more signal updates.
 *             All updates inside this function are batched together.
 *
 * @example
 * ```ts
 * const [a, setA] = createSignal(1);
 * const [b, setB] = createSignal(2);
 *
 * createEffect(() =>
 * {
 *     console.log(a() + b());
 * });
 * // Console: 3 (initial run)
 *
 * // Without batch — effect runs twice:
 * setA(10);  // Console: 12
 * setB(20);  // Console: 30
 *
 * // With batch — effect runs once:
 * batch(() =>
 * {
 *     setA(10);
 *     setB(20);
 * });
 * // Console: 30
 * ```
 *
 * @example
 * ```ts
 * // Nested batches are safe — only the outermost batch flushes
 * batch(() =>
 * {
 *   setA(1);
 *   batch(() =>  // Inner batch — just runs fn(), no new queue
 *   {
 *       setB(2);
 *   });
 *   setC(3);
 * });
 * // All three updates flushed together by the outer batch
 * ```
 */
export function batch(fn: () => void): void
{
    if (isBatching)
    {
        fn();
        return;
    }

    isBatching = true;
    batchQueue = new Set();

    try
    {
        fn();
    }
    finally
    {
        isBatching = false;

        const queue: Set<Subscriber> = batchQueue ?? new Set();
        batchQueue = null;

        for (const effect of queue)
        {
            effect();
        }
    }
}
