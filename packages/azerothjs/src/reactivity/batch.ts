/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

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
import type { Owner } from './create-root.ts';
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

/** One unhandled effect error of the flush; a dropped one is marked dead. */
interface Thrown
{
    error: unknown;
    live: boolean;
}

/** A failed effect's scope, its error, and the stamp the failure took. */
interface Failure
{
    scope: Owner;
    slot: Thrown;
    at: number;
}

/**
 * The multi-effect round being drained, the index of the effect running in it, and how many
 * effects were queued for the next round when that effect began.
 */
let round: Subscriber[] | null = null;
let roundAt = 0;
let roundQueued = 0;

/** The flush's unhandled effect errors in throw order; null until one fails. */
let thrown: Thrown[] | null = null;

/**
 * Set by the first error of the flush nothing can drop: no later error can be thrown ahead of it.
 */
let decided = false;

/**
 * Failures an ancestor effect was waiting to run past when they threw; settled after each round.
 */
let held: Failure[] = [];

/**
 * Failures nothing holds: dropped when the flush ends if an ancestor effect ran after them
 * and they were disposed.
 */
let late: Failure[] = [];

/** Once the flush has failed: a counter, and its value at each watched scope's latest run. */
let stamp = 0;
let lastRun: Map<Owner, number> | null = null;

/** The scopes above held and late failures, the only ones whose runs are stamped. */
let watched: Set<Owner> | null = null;

/** Watches the scopes above a failure; the walk stops at a watched one, whose parents are too. */
function watch(scope: Owner): void
{
    const set = watched ??= new Set();
    for (let s = scope.parent; s !== null && !set.has(s); s = s.parent)
    {
        set.add(s);
    }
}

/**
 * By scope: the effects still ahead in this round and those queued for the next, with their
 * positions. Built on a round's first failure; queueEffect adds to `queuedAt` while it lives.
 */
let ahead: Map<Owner, number> | null = null;
let queuedAt: Map<Owner, number> | null = null;

const NONE = 0;
const WAITED = 1;
const QUEUED = 2;

/**
 * The nearest ancestor effect of `scope` still due to run decides: WAITED if it was due
 * before the failed run began (ahead in the round, or among the first `since` queued), QUEUED
 * if that run queued it.
 */
function ancestorWaits(scope: Owner, since: number): number
{
    let inRound = ahead;
    let next = queuedAt;
    if (inRound === null || next === null)
    {
        inRound = ahead = new Map();
        next = queuedAt = new Map();
        if (round !== null)
        {
            for (let i = roundAt + 1; i < round.length; i++)
            {
                const owner = round[i]?.owner;
                if (owner !== undefined)
                {
                    inRound.set(owner, i);
                }
            }
        }
        if (solo?.owner !== undefined)
        {
            next.set(solo.owner, 0);
        }
        let at = 0;
        for (const subscriber of queue)
        {
            if (subscriber.owner !== undefined)
            {
                next.set(subscriber.owner, at);
            }
            at++;
        }
    }
    for (let s = scope.parent; s !== null; s = s.parent)
    {
        if ((inRound.get(s) ?? -1) > roundAt)
        {
            return WAITED;
        }
        const at = next.get(s);
        if (at !== undefined)
        {
            return at < since ? WAITED : QUEUED;
        }
    }
    return NONE;
}

/**
 * After a round: drops the errors of failed effects that were disposed, keeps those an
 * ancestor still waits past, and sends the rest to the end of the flush.
 */
function settleHeld(): void
{
    const entries = held;
    held = [];
    for (const entry of entries)
    {
        if (entry.scope.disposed)
        {
            entry.slot.live = false;
        }
        else if (ancestorWaits(entry.scope, Infinity) !== NONE)
        {
            held.push(entry);
        }
        else
        {
            late.push(entry);
        }
    }
}

/** Stamps a watched scope's run whose body ran; a run its sources net out of is not stamped. */
function stampRun(subscriber: Subscriber, before: number): void
{
    if (subscriber.activeRun !== before && subscriber.owner !== undefined && watched !== null && watched.has(subscriber.owner))
    {
        (lastRun ??= new Map()).set(subscriber.owner, ++stamp);
    }
}

/** Clears the failure state at the end of a flush. */
function clearFailure(): void
{
    thrown = null;
    decided = false;
    held = [];
    late = [];
    lastRun = null;
    watched = null;
    ahead = null;
    queuedAt = null;
    round = null;
}

/** Whether an ancestor effect of the failure's scope ran after it failed. */
function ancestorRanSince(failure: Failure): boolean
{
    for (let s = failure.scope.parent; s !== null; s = s.parent)
    {
        if ((lastRun?.get(s) ?? -1) > failure.at)
        {
            return true;
        }
    }
    return false;
}

/** Whether a batch is open; createEffect reads it to decide run-now vs queue. @internal */
export function isBatching(): boolean
{
    return batching;
}

/** Queues an effect to run when the current batch flushes. @internal */
export function queueEffect(subscriber: Subscriber): void
{
    if (queuedAt !== null && subscriber.owner !== undefined && !queuedAt.has(subscriber.owner))
    {
        queuedAt.set(subscriber.owner, solo === null ? queue.size : 1);
    }
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
    catch (error)
    {
        // Inline, not a call: the throw may be stack exhaustion, and a call could overflow again.
        thrown = null;
        decided = false;
        held = [];
        late = [];
        lastRun = null;
        watched = null;
        ahead = null;
        queuedAt = null;
        round = null;
        throw error;
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

    // Run one queued effect in ISOLATION: an effect whose body throws with no error handler
    // (no catchError, no uncaught handler) must not strand the rest of THIS flush - the other
    // affected effects still run on settled state. The first such error that is not dropped is
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
            if (decided)
            {
                return;
            }
            const slot = { error, live: true };
            (thrown ??= []).push(slot);
            const scope = subscriber.owner;
            // An effect whose own run disposed it closed itself: a real failure.
            if (scope === undefined || scope.disposed)
            {
                decided = true;
                return;
            }
            const wait = ancestorWaits(scope, round === null ? 0 : roundQueued);
            if (wait === WAITED)
            {
                watch(scope);
                held.push({ scope, slot, at: ++stamp });
            }
            else if (wait === QUEUED)
            {
                decided = true;
            }
            else
            {
                watch(scope);
                late.push({ scope, slot, at: ++stamp });
            }
        }
    };

    while (solo !== null || queue.size > 0)
    {
        ahead = null;
        queuedAt = null;
        if (solo !== null && queue.size === 0)
        {
            // Fast lane: the round's one effect, no Set traffic at all.
            const only = solo;
            solo = null;
            if (watched === null)
            {
                run(only);
            }
            else
            {
                const before = only.activeRun;
                run(only);
                stampRun(only, before);
            }
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

            round = effects;
            roundAt = -1;
            for (const subscriber of effects)
            {
                roundAt++;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an earlier run() in this loop can queue the solo; the rule narrows it from the spill above
                roundQueued = solo === null ? queue.size : 1;
                if (watched === null)
                {
                    run(subscriber);
                }
                else
                {
                    const before = subscriber.activeRun;
                    run(subscriber);
                    stampRun(subscriber, before);
                }
            }
            round = null;
        }

        if (held.length > 0)
        {
            settleHeld();
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

    // The whole queue drained; surface the first effect error that was not dropped (if any).
    const errors = thrown;
    if (errors === null)
    {
        return;
    }
    for (const failure of late)
    {
        if (failure.scope.disposed && ancestorRanSince(failure))
        {
            failure.slot.live = false;
        }
    }
    clearFailure();
    const first = errors.find((slot) => slot.live);
    if (first !== undefined)
    {
        throw first.error;
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
    catch (error)
    {
        // Inline for the same reason as in notifyWrite.
        thrown = null;
        decided = false;
        held = [];
        late = [];
        lastRun = null;
        watched = null;
        ahead = null;
        queuedAt = null;
        round = null;
        throw error;
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
