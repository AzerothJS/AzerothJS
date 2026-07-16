/**
 * MODULE: reactivity/graph (internal)
 *
 * The reactive graph's link machinery, shared by signals, memos, effects, and
 * selectors. Producers (signals, memos, selector keys) and consumers (effects, memos)
 * are connected by {@link Link} records held in plain arrays on BOTH sides, each link
 * knowing its slot in the producer's list so removal is one swap.
 *
 * DEPENDENCY-TRACKING MODEL (why this module exists):
 * The defining property is what a re-run does NOT do - it does not tear the dependency
 * list down and rebuild it. A consumer keeps its links in read order with a cursor:
 * beginTrack resets the cursor, each tracked read advances it (matching the previous
 * run's link at the same position with one pointer compare), and endTrack unlinks only
 * the tail the run left untouched. So a run that reads the same producers in the same
 * order - the overwhelmingly common case in fine-grained UI - costs one comparison per
 * read and allocates nothing. Branch changes (a read that appears/disappears) are
 * handled by a swap-into-place search, and genuinely new dependencies append a link.
 * The previous design unsubscribed and resubscribed every dependency on every run,
 * which dominated write-heavy profiles.
 *
 * Every export here is @internal: it is the bookkeeping contract the primitive modules
 * pass between themselves, not public API.
 */

import type { Subscriber, Producer, Link } from './types.ts';
import type { CleanupFn } from './types.ts';

/**
 * The effect/memo currently running, or null outside any tracked run. Read by track()
 * to know whom to subscribe.
 *
 * @internal
 */
export let currentSubscriber: Subscriber | null = null;

/**
 * Sets the active subscriber (used by run setup/teardown and untrack).
 *
 * @internal
 * @param sub - The subscriber to make active, or null.
 */
export function setCurrentSubscriber(sub: Subscriber | null): void
{
    currentSubscriber = sub;
}

/**
 * The cleanup array for the currently running consumer, or null. onCleanup() pushes here.
 *
 * @internal
 */
export let currentCleanups: CleanupFn[] | null = null;

/**
 * Sets the active cleanup array (used by run setup/teardown).
 *
 * @internal
 * @param cleanups - The active run's cleanup array, or null.
 */
export function setCurrentCleanups(cleanups: CleanupFn[] | null): void
{
    currentCleanups = cleanups;
}

/**
 * Global run counter. Each tracked run gets a fresh stamp, so a producer can detect
 * "already tracked by this consumer in this run" with two compares, not a set lookup.
 *
 * @internal
 */
let runClock = 0;

/**
 * Creates an empty producer node.
 *
 * @internal
 * @returns A fresh {@link Producer} with no subscribers and version 0.
 */
export function createProducer(): Producer
{
    // All optional fields are initialised here (to null) rather than added later by
    // memo/selector. Adding a property after construction would give memo producers a
    // different V8 hidden class from signal producers, making `producer.pull` in the
    // hot depsChanged loop a polymorphic (slow) property access. One stable shape keeps
    // it monomorphic.
    return { subs: [], seenConsumer: null, seenRun: 0, version: 0, pull: null, onUnsubscribed: null };
}

/**
 * Subscribes the running consumer (if any) to `producer`. Idempotent within a run, and
 * allocation-free when the consumer's dependency order is unchanged from its last run
 * (fast path: same producer at the same cursor position; otherwise swap an existing
 * link into place, or append a genuinely new one).
 *
 * @internal
 * @param producer - The producer being read.
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
 * {@link endTrack} in a finally.
 *
 * @internal
 * @param consumer - The consumer about to run.
 */
export function beginTrack(consumer: Subscriber): void
{
    consumer.activeRun = ++runClock;
    consumer.cursor = 0;
}

/**
 * Ends a tracked run: unlink every dependency the run did not touch (anything at or
 * past the cursor), keep the rest untouched.
 *
 * @internal
 * @param consumer - The consumer whose run just finished.
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

/**
 * Detaches one link from its producer (swap-remove, O(1)); fires onUnsubscribed when
 * the producer's last subscriber leaves.
 *
 * @internal
 * @param link - The link to detach.
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
 * Detaches a consumer from every producer it subscribes to (disposal path).
 *
 * @internal
 * @param consumer - The consumer to fully unsubscribe.
 */
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
 * Notifies every consumer of `producer`. Memo consumers (those with notifyDirty) are
 * only MARKED (they recompute on read); effect consumers execute (and validate
 * versions first, which preserves "a memo that recomputes equal does not re-run its
 * readers"). The single-subscriber case (one binding per signal, the dominant
 * fine-grained shape) avoids the fan-out snapshot; fan-out snapshots because a consumer
 * may (un)subscribe others, or itself, as it runs.
 *
 * @internal
 * @param producer - The producer whose value changed.
 * @param viaMemo - True when the change is propagating through a memo (passed to
 *                  notifyDirty so the consumer goes maybe-dirty rather than dirty).
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
 * Whether anything `consumer` reads has actually changed since its last run: settles
 * memo dependencies (pull), then compares each producer's version against the link's
 * recorded one. The cheap gate that lets an effect notified through a memo chain skip
 * its body when every recompute came out equal.
 *
 * @internal
 * @param consumer - The consumer to validate.
 * @returns True if at least one dependency's version advanced.
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
