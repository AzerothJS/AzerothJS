// The reactive graph's link machinery, shared by signals, memos, effects,
// and selectors. Producers (signals, memos, selector keys) and consumers
// (effects, memos) are connected by Link records held in plain arrays on
// BOTH sides, each link knowing its slot in the producer's list so removal
// is one swap.
//
// The point of this module is what re-running does NOT do: it does not tear
// the dependency list down and rebuild it. Consumers keep their links in
// read order with a cursor. A run that reads the same producers in the same
// order - the overwhelmingly common case - costs one pointer comparison per
// read and allocates nothing; only links left unread at the end of a run
// are unlinked. The previous design unsubscribed and resubscribed every
// dependency on every run, which dominated write-heavy profiles.

import type { Subscriber, Producer, Link } from './types.ts';
import type { CleanupFn } from './types.ts';

/**
 * The effect/memo currently running, or null outside any tracked run. Set
 * around each run; read by track() to know who to subscribe.
 *
 * @internal
 */
export let currentSubscriber: Subscriber | null = null;

/** @internal */
export function setCurrentSubscriber(sub: Subscriber | null): void
{
    currentSubscriber = sub;
}

/**
 * The cleanup array for the currently running consumer, or null when none
 * is running. onCleanup() pushes into this during a run.
 *
 * @internal
 */
export let currentCleanups: CleanupFn[] | null = null;

/** @internal */
export function setCurrentCleanups(cleanups: CleanupFn[] | null): void
{
    currentCleanups = cleanups;
}

/**
 * Global run counter. Each tracked run gets a fresh stamp so a producer can
 * detect "already tracked by this consumer in this run" with two compares
 * instead of a set lookup.
 *
 * @internal
 */
let runClock = 0;

/** Creates an empty producer node. @internal */
export function createProducer(): Producer
{
    return { subs: [], seenConsumer: null, seenRun: 0, version: 0 };
}

/**
 * Subscribes the running consumer (if any) to `producer`. Idempotent within
 * a run, allocation-free when the consumer's dependency order is unchanged
 * from its previous run.
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

    // Fast path: same producer at the same position as the previous run.
    if (cursor < deps.length && deps[cursor].producer === producer)
    {
        deps[cursor].version = producer.version;
        consumer.cursor++;
        return;
    }

    // The dependency order changed (a branch flipped): look for an existing
    // link later in the list and swap it into place.
    for (let i = cursor + 1; i < deps.length; i++)
    {
        if (deps[i].producer === producer)
        {
            const link = deps[i];
            deps[i] = deps[cursor];
            deps[cursor] = link;
            link.version = producer.version;
            consumer.cursor++;
            return;
        }
    }

    // Genuinely new dependency.
    const link: Link = { producer, consumer, slot: producer.subs.length, version: producer.version };
    producer.subs.push(link);
    if (cursor < deps.length)
    {
        deps.push(deps[cursor]);
        deps[cursor] = link;
    }
    else
    {
        deps.push(link);
    }
    consumer.cursor++;
}

/**
 * Starts a tracked run for `consumer`: stamps the run and resets the
 * dependency cursor. Pair with endTrack() in a finally.
 *
 * @internal
 */
export function beginTrack(consumer: Subscriber): void
{
    consumer.activeRun = ++runClock;
    consumer.cursor = 0;
}

/**
 * Ends a tracked run: every link the run did not touch (anything at or past
 * the cursor) is a dependency the consumer no longer reads - unlink those,
 * keep the rest untouched.
 *
 * @internal
 */
export function endTrack(consumer: Subscriber): void
{
    const deps = consumer.deps;
    // A dispose during the run (root teardown from inside the body) empties
    // deps while the cursor is still active - never let the length GROW.
    const keep = Math.min(consumer.cursor < 0 ? deps.length : consumer.cursor, deps.length);
    for (let i = deps.length - 1; i >= keep; i--)
    {
        unlink(deps[i]);
    }
    deps.length = keep;
    consumer.cursor = -1;
}

/**
 * Detaches one link from its producer (swap-remove, O(1)). Fires the
 * producer's onUnsubscribed hook when its last subscriber leaves.
 *
 * @internal
 */
function unlink(link: Link): void
{
    const subs = link.producer.subs;
    const last = subs.pop();
    if (last !== undefined && last !== link)
    {
        subs[link.slot] = last;
        last.slot = link.slot;
    }
    if (subs.length === 0 && link.producer.onUnsubscribed)
    {
        link.producer.onUnsubscribed();
    }
}

/**
 * Detaches a consumer from every producer it subscribes to. Disposal path.
 *
 * @internal
 */
export function unlinkAll(consumer: Subscriber): void
{
    const deps = consumer.deps;
    for (let i = deps.length - 1; i >= 0; i--)
    {
        unlink(deps[i]);
    }
    deps.length = 0;
}

/**
 * Notifies every consumer subscribed to `producer`. Memo consumers (those
 * with notifyDirty) are only MARKED - they recompute when something reads
 * them. Effect consumers execute; their execute() validates dependency
 * versions first, which is what preserves the "a memo that recomputes to an
 * equal value does not re-run its readers" contract under the lazy model.
 *
 * The single-subscriber case - one binding per signal, the dominant shape
 * in fine-grained UI - runs without a snapshot allocation; fan-out
 * snapshots because a consumer may subscribe or unsubscribe others (or
 * itself) as it runs. (A reusable scratch buffer was tried here and
 * measured no faster - the mixed-type slots cost more than the slice
 * saves.)
 *
 * @internal
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
        const only = subs[0].consumer;
        if (!only.isDisposed)
        {
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
 * Whether anything `consumer` reads has actually changed since its last
 * run: settles memo dependencies (pull), then compares each producer's
 * version against the link's recorded one. The cheap gate that lets an
 * effect notified through a memo chain skip its body when every recompute
 * came out equal.
 *
 * @internal
 */
export function depsChanged(consumer: Subscriber): boolean
{
    const deps = consumer.deps;
    for (let i = 0; i < deps.length; i++)
    {
        const link = deps[i];
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
