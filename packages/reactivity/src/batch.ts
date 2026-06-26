/**
 * MODULE: reactivity/batch
 *
 * Batching defers effect execution until a group of signal writes is complete. By
 * default each setter notifies its subscribers synchronously, so writing two signals
 * an effect depends on runs that effect twice - once on intermediate, inconsistent
 * state. Inside batch() affected effects are collected in a dedup set and run once,
 * after the batch, with all writes applied.
 */

import type { Subscriber } from './types.ts';
import { assertFunction } from './validate.ts';

/** True while inside batch(); effects queue instead of running. @internal */
let batching = false;

/** Effects pending after the batch; a Set so a repeatedly-triggered effect runs once. @internal */
const queue = new Set<Subscriber>();

/**
 * Upper bound on flush rounds before we declare a feedback loop. A healthy batch
 * settles in 1-2 rounds (writes, then the effects that observe them). A four-figure
 * cap is unreachable by legitimate code yet still catches a runaway cycle promptly.
 * @internal
 */
const MAX_FLUSH_ROUNDS = 1000;

/**
 * Whether a batch is currently open. createEffect reads this to decide run-now vs queue.
 *
 * @internal
 * @returns True if inside an open batch().
 */
export function isBatching(): boolean
{
    return batching;
}

/**
 * Queues an effect to run when the current batch flushes.
 *
 * @internal
 * @param subscriber - The effect to defer.
 */
export function queueEffect(subscriber: Subscriber): void
{
    queue.add(subscriber);
}

/**
 * batch
 *
 * PURPOSE:
 * Runs `fn` with effect execution deferred, so signal writes inside it apply
 * eagerly but dependent effects run once afterwards instead of once per write.
 *
 * WHY IT EXISTS:
 * Every setter notifies synchronously, so a sequence of related writes runs a shared
 * dependent effect once per write - each time on partially-updated, inconsistent
 * state. batch collapses that to a single run over the final values, which both
 * avoids wasted work and prevents observers from ever seeing a half-applied update.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity scheduling. Used around multi-field state transitions (form
 * resets, applying a server payload). It is explicit - the runtime does not
 * auto-batch arbitrary code.
 *
 * INPUT CONTRACT:
 * - fn performs the writes synchronously. Only synchronous writes inside fn are
 *   batched. Nesting is allowed: an inner batch() just runs its body; only the
 *   outermost batch flushes.
 *
 * OUTPUT CONTRACT:
 * - Returns void. After the outermost fn returns, each affected (non-disposed)
 *   effect executes exactly once.
 *
 * WHY THIS DESIGN:
 * A Set dedupes effects triggered by several writes. The queue is copied and cleared
 * before the flush so iteration is over a stable list. Only the outermost call
 * flushes, which makes nested batches compose without double-flushing.
 *
 * WHEN TO USE:
 * Whenever you write multiple signals that share downstream effects and want a single
 * consistent update.
 *
 * WHEN NOT TO USE:
 * For a single write (no benefit). Do not expect it to span async work - writes made
 * after an `await` inside fn are no longer batched.
 *
 * EDGE CASES:
 * - Effects disposed during the batch are skipped at flush.
 * - Reading a memo inside the batch still returns a value computed from current
 *   inputs (memos settle on read, independent of the effect queue).
 *
 * PERFORMANCE NOTES:
 * O(writes) to enqueue (deduped) and O(unique affected effects) to flush. The win is
 * eliminating redundant effect runs and intermediate-state renders.
 *
 * DEVELOPER WARNING:
 * Only synchronous writes inside fn are coalesced. An exception thrown by fn still
 * triggers the flush (it runs in finally), so effects see whatever writes landed
 * before the throw.
 *
 * @param fn - A function performing one or more signal writes.
 * @returns void
 * @see {@link createEffect}
 * @example
 * const [first, setFirst] = createSignal('Jane');
 * const [last, setLast] = createSignal('Smith');
 * createEffect(() => console.log(`${ first() } ${ last() }`));
 * batch(() => { setFirst('John'); setLast('Doe'); }); // logs "John Doe" once
 */
export function batch(fn: () => void): void
{
    assertFunction(fn, 'batch', 'Pass the writes as a function: batch(() => { setA(1); setB(2); }).');

    // Nested call: the outer batch owns the flush, so just run the body.
    if (batching)
    {
        fn();
        return;
    }

    batching = true;

    // Capture (don't propagate yet) an error from fn: the flush must run even if fn threw - effects
    // observe whatever writes landed before the throw - and fn's error should win in the normal case,
    // so it is rethrown only AFTER the flush. Throwing the flush's own cap error here (rather than from
    // inside the finally) keeps it out of a finally block, where it could mask fn's error.
    let fnError: unknown;
    let fnThrew = false;
    try
    {
        fn();
    }
    catch (error)
    {
        fnThrew = true;
        fnError = error;
    }

    // Stay in batching mode THROUGH the flush: a write performed by a flushed effect must re-queue the
    // affected effects (and run once, after) rather than notify synchronously and re-enter the flush
    // mid-iteration on inconsistent, half-applied state. Drain in rounds until the queue settles.
    try
    {
        let guard = 0;
        while (queue.size > 0)
        {
            // Copy before running because a queued effect may queue more.
            const effects = Array.from(queue);
            queue.clear();

            for (const subscriber of effects)
            {
                if (!subscriber.isDisposed)
                {
                    // Run the body directly (not execute(), which would just re-queue while batching is
                    // still true). Writes this run makes notify through execute() and so defer to the next round.
                    (subscriber.runScheduled ?? subscriber.execute)();
                }
            }

            // A flush that never settles means an effect keeps writing a signal it (transitively) depends
            // on. Bound it and surface the cause instead of hanging the tab forever.
            if (++guard > MAX_FLUSH_ROUNDS)
            {
                queue.clear();
                throw new Error(
                    `batch() flush did not settle after ${ MAX_FLUSH_ROUNDS } rounds: an effect ` +
                    'keeps writing a signal it depends on, forming a feedback loop. Break the ' +
                    'cycle (derive with createMemo, guard the write, or read with untrack).'
                );
            }
        }
    }
    finally
    {
        batching = false;
    }

    if (fnThrew)
    {
        throw fnError;
    }
}
