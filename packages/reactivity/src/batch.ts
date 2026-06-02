// batch() groups multiple signal updates, deferring effect execution until
// all of them are done. Without it, setting two signals an effect depends on
// runs that effect twice - once with intermediate state. Inside a batch the
// effect is queued (deduped) and runs once, after the batch, with both values.

import type { Subscriber } from './types.ts';

/**
 * Whether we are inside a batch() call. When true, effects are queued instead
 * of running immediately.
 *
 * @internal
 */
let batching = false;

/**
 * Effects waiting to run after the batch completes. A Set so an effect
 * triggered several times during a batch still runs once.
 *
 * @internal
 */
const queue = new Set<Subscriber>();

/**
 * Whether we are currently inside a batch. createEffect uses this to decide
 * whether to run immediately or queue.
 *
 * @internal
 */
export function isBatching(): boolean
{
    return batching;
}

/**
 * Queues an effect to run after the current batch completes.
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
 * Groups multiple signal updates, deferring effect execution until `fn`
 * returns. Affected effects run once afterwards, even if their dependencies
 * changed several times. Nests: inner batch() calls just run their function;
 * only the outermost batch flushes.
 *
 * @param fn - A function containing multiple signal updates
 *
 * Why: each setter notifies subscribers immediately, so several updates in a
 * row run a dependent effect once per update.
 *
 * Without batch: two setters fire the effect twice, once mid-update:
 *
 *     setFirst('John');
 *     setLast('Doe'); // effect already ran once on "John Smith"
 *
 * With batch: the effect runs once, after both updates land:
 *
 *     batch(() =>
 *     {
 *         setFirst('John');
 *         setLast('Doe');
 *     }); // effect runs a single time, seeing "John Doe"
 *
 * @example
 * ```ts
 * const [first, setFirst] = createSignal('Jane');
 * const [last, setLast] = createSignal('Smith');
 * createEffect(() => console.log(`${ first() } ${ last() }`));
 *
 * batch(() =>
 * {
 *     setFirst('John');
 *     setLast('Doe');
 * });
 * // Logs "John Doe" once, not twice
 * ```
 */
export function batch(fn: () => void): void
{
    // Nested call: the outer batch owns the flush, so just run the body.
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

        // Copy before flushing because a queued effect may queue new ones.
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
