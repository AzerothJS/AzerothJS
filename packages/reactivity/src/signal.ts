// A signal is a reactive value that notifies subscribing effects when it
// changes - the atomic unit of state.
//
// Signals and effects reference each other through the link records in
// graph.ts: a signal's producer holds a link per subscribed consumer, and
// each consumer holds the same links in read order. Disposing an effect
// walks its links, detaching it from every signal so it can be collected
// (otherwise disposed effects would linger in subscriber lists forever).

import type { Getter, Setter, Signal, SignalOptions, EqualsFn } from './types.ts';
import { createProducer, track, notify } from './graph.ts';
import { devtoolsHook, nextDevtoolsId, currentOwnerId, registerDevtoolsNode } from './devtools-hook.ts';

// Re-exported from graph.ts so existing importers (untrack, effect,
// create-selector) keep their import path; the state itself lives with the
// rest of the link machinery.
export { currentSubscriber, setCurrentSubscriber } from './graph.ts';

/**
 * Key under which a getter exposes its live subscriber count. Symbol-keyed so
 * it never collides with user properties and stays invisible to enumeration.
 *
 * @internal
 */
const SUBSCRIBER_COUNT = Symbol('azeroth_subscriber_count');

/**
 * The live subscriber-list size of a signal getter. Exists so leak tests can
 * assert that mount/unmount cycles return a signal to its baseline subscriber
 * count. Returns -1 for a function that is not a signal getter.
 *
 * @internal
 */
export function subscriberCount(getter: Getter<unknown>): number
{
    const probe = (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT];
    return typeof probe === 'function' ? (probe as () => number)() : -1;
}

/** Attaches the subscriber-count probe to a getter. @internal */
export function attachSubscriberProbe(getter: Getter<unknown>, count: () => number): void
{
    (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT] = count;
}

/**
 * Creates a reactive signal: a [getter, setter] pair. The getter subscribes
 * the running effect (if any); the setter notifies subscribers when the value
 * changes, compared with `Object.is` or a custom `equals`.
 *
 * @param initialValue - Starting value
 * @param options - Optional custom equality (default `Object.is`)
 * @returns A [getter, setter] tuple
 *
 * Without createSignal: plain state has no way to notify readers, so you mutate
 * and then have to remember to refresh everything that depended on it:
 *
 *     let count = 0;
 *     count++;
 *     rerenderEverything(); // easy to forget; any missed reader goes stale
 *
 * With createSignal: reads subscribe automatically and the setter notifies them:
 *
 *     const [count, setCount] = createSignal(0);
 *     setCount((n) => n + 1); // every effect/binding that read count re-runs
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * setCount(prev => prev + 1);
 * count(); // 1
 *
 * // Custom equality: only notify when the integer part changes.
 * const [price, setPrice] = createSignal(9.99, {
 *     equals: (a, b) => Math.floor(a) === Math.floor(b)
 * });
 * setPrice(9.50); // no notification
 * ```
 */
export function createSignal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T>
{
    let value: T = initialValue;
    const producer = createProducer();
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    // 0 = no devtools at creation; the write-path check below is then a
    // constant-false number compare.
    let debugId = 0;

    const getter: Getter<T> = (): T =>
    {
        track(producer);
        return value;
    };

    attachSubscriberProbe(getter, (): number => producer.subs.length);

    const setter: Setter<T> = (newValue: T | ((prev: T) => T)): void =>
    {
        const resolved = typeof newValue === 'function' ? (newValue as (prev: T) => T)(value) : newValue;

        if (equals(value, resolved))
        {
            return;
        }

        value = resolved;
        producer.version++;
        if (debugId !== 0 && devtoolsHook)
        {
            devtoolsHook.write(debugId);
        }
        if (producer.subs.length !== 0)
        {
            notify(producer);
        }
    };

    // Devtools (off in production): attach attribution + value accessors to
    // the producer so the snapshot can read/edit this signal by id, holding
    // it only weakly. Done after getter/setter exist so peek/poke can use
    // them; the setter's write-path id check captures `debugId` lazily.
    if (devtoolsHook)
    {
        debugId = nextDevtoolsId();
        producer.dv = {
            id: debugId,
            kind: 'signal',
            name: options?.name,
            owner: currentOwnerId,
            peek: (): unknown => value,
            poke: (v: unknown): void => setter(v as T)
        };
        registerDevtoolsNode(debugId, producer);
        devtoolsHook.created({ id: debugId, kind: 'signal', name: options?.name, owner: currentOwnerId });
    }

    return [getter, setter];
}
