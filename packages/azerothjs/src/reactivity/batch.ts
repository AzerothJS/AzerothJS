/**
 * The write-flush scheduler that makes every write glitch-free, and the public batch()
 * that extends the same guarantee across a group of writes.
 *
 * Every top-level write runs inside an implicit flush ({@link notifyWrite}): the
 * notification wave only marks memos and queues affected effects, and once the wave has
 * fully propagated the queued effects run exactly once against settled memos. Without it,
 * a diamond - one signal feeding two memos read by one effect - fired the effect once per
 * branch, the first time on mixed-generation state with one memo fresh and the other
 * stale. The flush is synchronous: by the time a setter returns, every affected effect has
 * run.
 *
 * batch() widens that window across multiple writes. Two setters sharing a downstream
 * effect run it twice when unbatched (each time on consistent state) and once inside a
 * batch.
 */

import type { Producer, Subscriber } from './types.ts';
import { notify } from './graph.ts';
import { assertFunction } from './validate.ts';

/** True while inside batch(); effects queue instead of running. @internal */
let batching = false;

/** Effects pending after the batch; a Set so a repeatedly-triggered effect runs once. @internal */
const queue = new Set<Subscriber>();

/**
 * The queue's single-occupant fast lane. A top-level write to a signal with ONE
 * downstream effect - the dominant fine-grained binding shape - must not pay Set
 * insert/iterate/clear per write, so the first queued effect parks here and only a
 * SECOND distinct effect spills both into the Set. @internal
 */
let solo: Subscriber | null = null;

/**
 * Upper bound on flush rounds before we declare a feedback loop. A healthy batch
 * settles in 1-2 rounds (writes, then the effects that observe them). A four-figure
 * cap is unreachable by legitimate code yet still catches a runaway cycle promptly.
 * @internal
 */
const MAX_FLUSH_ROUNDS = 1000;

/** Whether a batch is open; createEffect reads it to decide run-now vs queue. @internal */
export function isBatching(): boolean
{
    return batching;
}

/** Queues an effect to run when the current batch flushes. @internal */
export function queueEffect(subscriber: Subscriber): void
{
    if (solo === null && queue.size === 0)
    {
        solo = subscriber;
        return;
    }
    if (solo !== null)
    {
        if (solo === subscriber)
        {
            return; // already queued (dedup, same as the Set's)
        }
        queue.add(solo);
        solo = null;
    }
    queue.add(subscriber);
}

/**
 * A top-level write's notification entry: opens an implicit flush window, propagates the
 * wave (memos mark, effects queue), then drains, so every affected effect runs exactly
 * once after the whole wave on settled state. This is what makes an unbatched write
 * glitch-free. A write landing inside an open window - a batch, a flushing effect's own
 * write, another write's wave - simply emits into it.
 *
 * @internal
 */
export function notifyWrite(producer: Producer): void
{
    if (batching)
    {
        notify(producer);
        return;
    }

    batching = true;
    try
    {
        notify(producer);
        drainQueue();
    }
    finally
    {
        batching = false;
    }
}

/**
 * Runs queued effects in rounds until the queue settles; a flushed effect's own writes
 * land in the next round. The single-effect round skips the snapshot copy.
 */
function drainQueue(): void
{
    let guard = 0;
    let firstError: unknown;
    let failed = false;

    // Run one queued effect in ISOLATION: an effect whose body throws with no error handler
    // (no catchError, no uncaught handler) must not strand the rest of THIS flush - the other
    // affected effects still run on settled state. The first such error is captured and
    // surfaced after the queue drains, so the write/batch still throws, just not mid-flush.
    const run = (subscriber: Subscriber): void =>
    {
        if (subscriber.isDisposed)
        {
            return;
        }
        try
        {
            // Run the body directly (not execute(), which would just re-queue while batching
            // is still true). Writes this run makes notify through execute() and so defer to
            // the next round.
            (subscriber.runScheduled ?? subscriber.execute)();
        }
        catch (error)
        {
            if (!failed)
            {
                failed = true;
                firstError = error;
            }
        }
    };

    while (solo !== null || queue.size > 0)
    {
        if (solo !== null && queue.size === 0)
        {
            // Fast lane: the round's one effect, no Set traffic at all.
            const only = solo;
            solo = null;
            run(only);
        }
        else
        {
            if (solo !== null)
            {
                queue.add(solo);
                solo = null;
            }
            // Copy before running because a queued effect may queue more.
            const effects = Array.from(queue);
            queue.clear();

            for (const subscriber of effects)
            {
                run(subscriber);
            }
        }

        // A flush that never settles means an effect keeps writing a signal it (transitively)
        // depends on. Bound it and surface the cause instead of hanging the tab forever.
        if (++guard > MAX_FLUSH_ROUNDS)
        {
            queue.clear();
            solo = null;
            throw new Error(
                `Reactive flush did not settle after ${ MAX_FLUSH_ROUNDS } rounds: an effect ` +
                'keeps writing a signal it depends on, forming a feedback loop. Break the ' +
                'cycle (derive with createMemo, guard the write, or read with untrack).'
            );
        }
    }

    // The whole queue drained; now surface the first effect error (if any).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `failed` is set inside the run() closure; the rule's flow analysis cannot see the mutation and narrows it to its initial false
    if (failed)
    {
        throw firstError;
    }
}

/**
 * Runs `fn` with effect execution deferred: writes inside it apply immediately, but the
 * effects that depend on them run once at the end instead of once per write.
 *
 * Only writes made SYNCHRONOUSLY inside `fn` are coalesced. Anything written after an
 * `await` lands outside the window and flushes on its own. Nesting is safe: an inner
 * batch just runs its body, and only the outermost call flushes.
 *
 * Memos are unaffected - they settle on read, so reading one inside the batch returns a
 * value computed from the writes that have already landed. Effects disposed during the
 * batch are skipped at flush time.
 *
 * If `fn` throws, the flush still runs and the error is rethrown afterwards, so effects
 * observe whatever writes landed before the throw.
 *
 * @typeParam T - `fn`'s return type.
 * @param fn - Performs one or more signal writes, synchronously.
 * @returns Whatever `fn` returns.
 * @throws {TypeError} If `fn` is not a function.
 * @throws The error `fn` threw, rethrown after the flush completes.
 * @throws {Error} If the flush fails to settle within 1000 rounds, which means an effect
 *                 keeps writing a signal it depends on.
 * @example
 * const [first, setFirst] = createSignal('Jane');
 * const [last, setLast] = createSignal('Smith');
 * createEffect(() => console.log(`${ first() } ${ last() }`));
 *
 * batch(() =>
 * {
 *     setFirst('John');
 *     setLast('Doe');
 * }); // logs "John Doe" once, not "John Smith" then "John Doe"
 *
 * @example
 * // The return value passes through.
 * const total = batch(() =>
 * {
 *     setItems(next);
 *     return next.length;
 * });
 *
 * @see {@link createEffect}
 */
export function batch<T>(fn: () => T): T
{
    assertFunction(fn, 'batch', 'Pass the writes as a function: batch(() => { setA(1); setB(2); }).');

    // Nested call: the outer batch owns the flush, so just run the body.
    if (batching)
    {
        return fn();
    }

    batching = true;

    // Capture (don't propagate yet) an error from fn: the flush must run even if fn threw - effects
    // observe whatever writes landed before the throw - and fn's error should win in the normal case,
    // so it is rethrown only AFTER the flush. Throwing the flush's own cap error here (rather than from
    // inside the finally) keeps it out of a finally block, where it could mask fn's error.
    let fnError: unknown;
    let fnThrew = false;
    let result!: T;
    try
    {
        result = fn();
    }
    catch (error)
    {
        fnThrew = true;
        fnError = error;
    }

    // Stay in batching mode THROUGH the flush: a write performed by a flushed effect must re-queue the
    // affected effects (and run once, after) rather than notify synchronously and re-enter the flush
    // mid-iteration on inconsistent, half-applied state.
    try
    {
        drainQueue();
    }
    finally
    {
        batching = false;
    }

    if (fnThrew)
    {
        throw fnError;
    }
    return result;
}
