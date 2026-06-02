// A signal is a reactive value that notifies subscribing effects when it
// changes - the atomic unit of state.
//
// Signals and effects reference each other: a signal holds the set of effects
// subscribed to it, and each effect holds cleanup closures that remove it from
// those sets. Disposing an effect runs its cleanups, detaching it from every
// signal so it can be collected (otherwise disposed effects would linger in
// subscriber sets forever).

import type { Getter, Setter, Signal, Subscriber, SignalOptions, EqualsFn } from './types.ts';

/**
 * The effect/memo currently running, or null outside any effect. Set by
 * createEffect before each run; read by a signal getter to know who to
 * subscribe.
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
    const subscribers = new Set<Subscriber>();
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    const getter: Getter<T> = (): T =>
    {
        // Subscribe the running effect at most once per signal. The Set makes
        // `add` idempotent, but the cleanup closure below is freshly allocated
        // each call and never compares equal, so without the `has` guard the
        // effect's dependency set would fill with duplicate unsubscribers.
        if (
            currentSubscriber !== null &&
            !currentSubscriber.isDisposed &&
            !subscribers.has(currentSubscriber)
        )
        {
            const sub = currentSubscriber;
            subscribers.add(sub);
            sub.dependencies.add(() =>
            {
                subscribers.delete(sub);
            });
        }

        return value;
    };

    const setter: Setter<T> = (newValue: T | ((prev: T) => T)): void =>
    {
        const resolved = typeof newValue === 'function' ? (newValue as (prev: T) => T)(value) : newValue;

        if (equals(value, resolved))
        {
            return;
        }

        value = resolved;

        // Snapshot the set: a subscriber may add or remove subscribers as it runs.
        for (const subscriber of Array.from(subscribers))
        {
            if (!subscriber.isDisposed)
            {
                subscriber.execute();
            }
            else
            {
                subscribers.delete(subscriber);
            }
        }
    };

    return [getter, setter];
}
