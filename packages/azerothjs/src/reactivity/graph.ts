/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The reactive graph's link machinery, shared by signals, memos, effects and selectors.
 * Producers and consumers are joined by {@link Link} records held in plain arrays on both
 * sides, each link recording its slot in the producer's list so removal is one swap.
 *
 * A re-run does not tear the dependency list down and rebuild it. A consumer keeps its
 * links in read order behind a cursor: beginTrack resets the cursor, each tracked read
 * advances it (matching the previous run's link at the same position with one pointer
 * compare), and endTrack unlinks only the tail the run left untouched. A run that reads
 * the same producers in the same order therefore allocates nothing; a branch flip swaps an
 * existing link into place, and a genuinely new read appends one. Resubscribing every
 * dependency on every run, the obvious alternative, dominated write-heavy profiles.
 *
 * Every export here is internal bookkeeping passed between the primitive modules.
 */

import type { Subscriber, Producer, Link, CleanupFn } from './types.ts';

/** The effect or memo currently running; null outside a tracked run. @internal */
export let currentSubscriber: Subscriber | null = null;

/** @internal */
export function setCurrentSubscriber(sub: Subscriber | null): void
{
    currentSubscriber = sub;
}

/** Cleanup array of the running consumer; where onCleanup() pushes. @internal */
export let currentCleanups: CleanupFn[] | null = null;

/** @internal */
export function setCurrentCleanups(cleanups: CleanupFn[] | null): void
{
    currentCleanups = cleanups;
}

/**
 * Every tracked run gets a fresh stamp, so a producer can decide "already tracked by this
 * consumer in this run" with two compares instead of a set lookup.
 */
let runClock = 0;

/** @internal */
export function createProducer(): Producer
{
    // Optional fields are initialised to null here rather than added later by memo/selector:
    // adding a property after construction would give memo producers a different hidden class
    // from signal producers, making `producer.pull` in the hot depsChanged loop a polymorphic
    // property access.
    return { subs: [], seenConsumer: null, seenRun: 0, version: 0, pull: null, onUnsubscribed: null };
}

/**
 * Subscribes the running consumer, if any, to `producer`. Idempotent within a run and
 * allocation-free while the consumer's read order is unchanged from its last run.
 *
 * @internal
 */
export function track(producer: Producer): void
{
    const consumer = currentSubscriber;
    if (consumer === null || consumer.isDisposed)
    {
        return;
    }

    // Repeated read of the same producer in one run: nothing to do.
    if (producer.seenConsumer === consumer && producer.seenRun === consumer.activeRun)
    {
        return;
    }
    producer.seenConsumer = consumer;
    producer.seenRun = consumer.activeRun;

    const deps = consumer.deps;
    const cursor = consumer.cursor;

    // The link currently occupying the cursor slot (undefined when the cursor is at the
    // list's end). One read serves the fast path, the swap, and the append below.
    const occupant = deps[cursor];

    // Fast path: same producer at the same position as the previous run.
    if (occupant !== undefined && occupant.producer === producer)
    {
        occupant.version = producer.version;
        consumer.cursor++;
        return;
    }

    // The dependency order changed (a branch flipped): find an existing link later in
    // the list and swap it into place. (No occupant means the cursor is past the end,
    // so there is nothing later in the list either - the loop body cannot run.)
    if (occupant !== undefined)
    {
        for (let i = cursor + 1; i < deps.length; i++)
        {
            const candidate = deps[i];
            if (candidate !== undefined && candidate.producer === producer)
            {
                deps[i] = occupant;
                deps[cursor] = candidate;
                candidate.version = producer.version;
                consumer.cursor++;
                return;
            }
        }
    }

    // Genuinely new dependency.
    const link: Link = { producer, consumer, slot: producer.subs.length, version: producer.version };
    producer.subs.push(link);
    if (occupant !== undefined)
    {
        deps.push(occupant);
        deps[cursor] = link;
    }
    else
    {
        deps.push(link);
    }
    consumer.cursor++;
}

/**
 * Starts a tracked run: stamps the run and resets the dependency cursor. Pair with
 * {@link endTrack} in a finally, or the consumer keeps a live cursor into a run that
 * already ended.
 *
 * @internal
 */
export function beginTrack(consumer: Subscriber): void
{
    consumer.activeRun = ++runClock;
    consumer.cursor = 0;
}

/**
 * Ends a tracked run, unlinking every dependency the run did not touch (anything at or
 * past the cursor) and leaving the rest in place.
 *
 * @internal
 */
export function endTrack(consumer: Subscriber): void
{
    const deps = consumer.deps;
    // A dispose during the run (root teardown from inside the body) empties deps while
    // the cursor is still active - never let the length GROW.
    const keep = Math.min(consumer.cursor < 0 ? deps.length : consumer.cursor, deps.length);
    for (let i = deps.length - 1; i >= keep; i--)
    {
        const link = deps[i];
        if (link !== undefined)
        {
            unlink(link);
        }
    }
    deps.length = keep;
    consumer.cursor = -1;
}

/** Swap-removes one link from its producer, firing onUnsubscribed when the last one leaves. */
function unlink(link: Link): void
{
    const subs = link.producer.subs;
    const last = subs.pop();
    if (last !== undefined && last !== link)
    {
        subs[link.slot] = last;
        last.slot = link.slot;
    }
    // Clear the track() dedup cache when it points at the consumer being detached, so a disposed
    // consumer's closure is not pinned on a long-lived producer until some other consumer reads it.
    if (link.producer.seenConsumer === link.consumer)
    {
        link.producer.seenConsumer = null;
    }
    if (subs.length === 0 && link.producer.onUnsubscribed)
    {
        link.producer.onUnsubscribed();
    }
}

/** Detaches a consumer from every producer it reads. The disposal path. @internal */
export function unlinkAll(consumer: Subscriber): void
{
    const deps = consumer.deps;
    for (let i = deps.length - 1; i >= 0; i--)
    {
        const link = deps[i];
        if (link !== undefined)
        {
            unlink(link);
        }
    }
    deps.length = 0;
}

/**
 * Notifies every consumer of `producer`. A memo consumer is only MARKED and recomputes on
 * read; an effect consumer executes, validating versions first, which is what preserves
 * "a memo that recomputes equal does not re-run its readers".
 *
 * Fan-out iterates a snapshot because a consumer may subscribe or unsubscribe others, or
 * itself, while it runs. The single-subscriber case skips the snapshot.
 *
 * @internal
 * @param viaMemo - True when the change arrives through a memo, which makes the consumer
 *                  maybe-dirty rather than dirty.
 */
export function notify(producer: Producer, viaMemo = false): void
{
    const subs = producer.subs;

    if (subs.length === 0)
    {
        return;
    }

    if (subs.length === 1)
    {
        const solo = subs[0];
        if (solo !== undefined && !solo.consumer.isDisposed)
        {
            const only = solo.consumer;
            if (only.notifyDirty)
            {
                only.notifyDirty(viaMemo);
            }
            else
            {
                only.execute();
            }
        }
        return;
    }

    const snapshot = subs.slice();
    for (const link of snapshot)
    {
        const consumer = link.consumer;
        if (!consumer.isDisposed)
        {
            if (consumer.notifyDirty)
            {
                consumer.notifyDirty(viaMemo);
            }
            else
            {
                consumer.execute();
            }
        }
    }
}

/**
 * Whether anything `consumer` reads actually changed since its last run: settles memo
 * dependencies through `pull`, then compares each producer's version against the version
 * the link recorded. This is the gate that lets an effect notified through a memo chain
 * skip its body when every recompute came out equal.
 *
 * @internal
 */
export function depsChanged(consumer: Subscriber): boolean
{
    const deps = consumer.deps;
    for (let i = 0; i < deps.length; i++)
    {
        const link = deps[i];
        if (link === undefined)
        {
            continue;
        }
        const producer = link.producer;
        if (producer.pull)
        {
            producer.pull();
        }
        if (producer.version !== link.version)
        {
            return true;
        }
    }
    return false;
}
