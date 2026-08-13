/**
 * The value cell layered over the reactive graph: this module owns storage and change
 * detection (the equality gate on the write path), while edge bookkeeping - createProducer,
 * track, notify - lives in ./graph.
 */

import type { Getter, Setter, Signal, SignalOptions, EqualsFn } from './types.ts';
import { createProducer, track } from './graph.ts';
import { notifyWrite } from './batch.ts';
import { dtRegister, dtWrite, dtEnabled } from './devtools.ts';

/** Symbol-keyed so the probe never collides with user properties or shows up in enumeration. */
const SUBSCRIBER_COUNT = Symbol('azeroth_subscriber_count');

/**
 * A signal getter's live subscriber count, or -1 for any function that is not one. Leak and
 * lifecycle tests use it to assert that disposal detached every consumer, which is why the
 * miss returns -1 rather than 0: "not a signal" has to be distinguishable from "a signal
 * nobody reads".
 *
 * @internal
 */
export function subscriberCount(getter: Getter<unknown>): number
{
    const probe = (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT];
    return typeof probe === 'function' ? (probe as () => number)() : -1;
}

/**
 * Installs the probe {@link subscriberCount} reads. Called once per signal at construction;
 * `count` must be a pure read, since it runs inside leak assertions.
 *
 * @internal
 */
export function attachSubscriberProbe(getter: Getter<unknown>, count: () => number): void
{
    (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT] = count;
}

/**
 * Creates a reactive value cell and returns its `[getter, setter]` pair.
 *
 * Reading the getter inside an effect or memo subscribes that consumer, so the read site
 * is the subscription site and there is no separate subscribe call to forget. Reading it
 * anywhere else returns the value and subscribes nothing.
 *
 * Writing runs the equality gate first: when `equals(current, next)` holds, the write is a
 * complete no-op - no version bump, no notification. Otherwise the value is replaced and
 * every subscriber is notified synchronously, unless the write happens inside `batch`, in
 * which case notification is deferred to the flush.
 *
 * `initialValue` is stored by reference and never cloned, so mutating an object in place
 * and setting the same reference back changes nothing under the default `Object.is`
 * comparator. Set a fresh reference, or supply an `equals` that compares contents.
 *
 * @typeParam T - The value type.
 * @param initialValue - The starting value, stored as given.
 * @param options - Optional settings.
 * @param options.equals - Change comparator; must be pure. Defaults to `Object.is`. A
 *                         comparator that wrongly reports equal silently freezes every
 *                         dependent.
 * @param options.name - Debug name shown in devtools.
 * @returns A {@link Signal}: `[getter, setter]`.
 * @example
 * const [count, setCount] = createSignal(0);
 * setCount(5);              // direct
 * setCount(n => n + 1);     // updater, receives the current value
 * count();                  // 6
 *
 * @example
 * // A function argument is always the updater, so a function VALUE must be wrapped.
 * const [view, setView] = createSignal<() => Element>(Home);
 * setView(() => About);
 *
 * @example
 * // Coarser change semantics without touching any call site.
 * const [price, setPrice] = createSignal(9.99, {
 *     equals: (a, b) => Math.floor(a) === Math.floor(b)
 * });
 * setPrice(9.50); // no notification: same integer part
 *
 * @see {@link createMemo} for values derived from other signals.
 * @see {@link createEffect} for reacting to them.
 */
export function createSignal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T>
{
    let value: T = initialValue;
    const producer = createProducer();
    const equals: EqualsFn<T> = options?.equals ?? Object.is;
    // Devtools node id (0 unless a devtools hook is attached); used to emit write events.
    let devtoolsId = 0;

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
        // Inline the id guard so a write touches devtools only when a node was registered (a hook is
        // attached); the common production path is one comparison, not a call.
        if (devtoolsId !== 0)
        {
            dtWrite(devtoolsId);
        }
        if (producer.subs.length !== 0)
        {
            notifyWrite(producer);
        }
    };

    devtoolsId = dtEnabled()
        ? dtRegister('signal', {
            name: options?.name,
            producer,
            getValue: (): unknown => value,
            setValue: (v: unknown): void => setter(v as T)
        })
        : 0;

    return [getter, setter];
}
