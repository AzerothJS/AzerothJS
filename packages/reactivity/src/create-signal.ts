/**
 * MODULE: reactivity/create-signal
 *
 * Signals are the atomic unit of reactive state. A signal is a [getter, setter]
 * pair over a single value cell: reading the getter inside a tracking scope
 * records a dependency edge, and writing the setter propagates a change to every
 * consumer that read it.
 *
 * ARCHITECTURE:
 * A signal owns a producer record (see {@link Producer} in ./types, built by
 * ./graph). The producer holds a subscriber list of link records; each link is
 * shared with the consuming effect or memo, which holds the same link in read
 * order. This shared double-linked structure is what makes teardown
 * O(subscriptions): disposing a consumer walks its links and detaches itself from
 * every producer, so a torn-down consumer leaves no dangling entry in any signal's
 * subscriber list. Without it, disposed consumers would accumulate in subscriber
 * lists, leak memory, and keep receiving notifications.
 *
 * This module owns value storage and change detection (the equality gate on the
 * write path). Edge bookkeeping (createProducer/track/notify) lives in ./graph;
 * this module is the value cell layered on top of that graph.
 */

import type { Getter, Setter, Signal, SignalOptions, EqualsFn } from './types.ts';
import { createProducer, track, notify } from './graph.ts';
import { dtRegister, dtWrite } from './devtools.ts';

/**
 * Symbol key under which a getter exposes its live subscriber count. Symbol-keyed
 * so it never collides with user properties and stays invisible to enumeration.
 *
 * @internal Not exported.
 */
const SUBSCRIBER_COUNT = Symbol('azeroth_subscriber_count');

/**
 * Reports a signal getter's live subscriber count, or -1 if the function is not a
 * signal getter. Used by leak/lifecycle tests to assert that disposal detached
 * every consumer; the count is read through a Symbol-keyed probe so it never
 * collides with user state. Returns -1 (not 0) so "not a signal" is
 * distinguishable from "a signal with zero subscribers".
 *
 * @internal
 * @param getter - A signal getter (any other function yields -1).
 * @returns The live subscriber count, or -1 if `getter` carries no probe.
 * @see {@link attachSubscriberProbe}
 */
export function subscriberCount(getter: Getter<unknown>): number
{
    const probe = (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT];
    return typeof probe === 'function' ? (probe as () => number)() : -1;
}

/**
 * Installs the subscriber-count probe onto a signal getter so {@link
 * subscriberCount} can read it later. Called once per signal at construction; the
 * probe must be a pure read, since it runs during leak assertions.
 *
 * @internal
 * @param getter - The signal getter to annotate.
 * @param count - A pure thunk returning the getter's current subscriber count.
 * @see {@link subscriberCount}
 */
export function attachSubscriberProbe(getter: Getter<unknown>, count: () => number): void
{
    (getter as unknown as Record<symbol, unknown>)[SUBSCRIBER_COUNT] = count;
}

/**
 * createSignal
 *
 * PURPOSE:
 * Allocates a reactive value cell and returns a [getter, setter] pair. The getter
 * returns the current value and, inside a tracking scope, subscribes that scope to
 * future changes. The setter assigns a new value and, only when it differs by the
 * equality function, bumps the producer version and notifies subscribers.
 *
 * WHY IT EXISTS:
 * It is the primitive every other reactive construct is built on - memo, effect,
 * store, resource, and the renderer's bindings. Fine-grained updates require state
 * that knows its own readers; a signal is the smallest object that carries both a
 * value and its subscriber set, so a write can update exactly the readers that
 * depend on it instead of re-running a component or diffing a tree.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. Compiled `.azeroth` `state` declarations lower to
 * createSignal calls; the getter is invoked inside renderer bindings and memos,
 * which is how the dependency graph is populated. In SSR/string mode the getter
 * still returns the value, but no subscription outlives the synchronous render.
 *
 * INPUT CONTRACT:
 * - initialValue is the starting value; stored by reference, never cloned.
 * - options.equals is optional, defaults to Object.is; must be pure and reflexive
 *   and decides whether a write is a no-op.
 *
 * OUTPUT CONTRACT:
 * - Returns a tuple [getter, setter].
 * - getter(): returns the current value; subscribes the active scope if any.
 * - setter(next | (prev) => next): assigns; the functional form receives the
 *   current value. Returns void. Notifies only when equals(old, new) is false.
 *
 * WHY THIS DESIGN:
 * A getter/setter pair (rather than a mutable property) makes the read site the
 * subscription site: there is no separate subscribe call to forget, and tracking
 * is automatic and exact. Object.is as the default stops idempotent writes from
 * cascading; a custom equals allows coarser change semantics without touching call
 * sites.
 *
 * WHEN TO USE:
 * For any independently writable piece of state. Pair with {@link createMemo} for
 * derived values and {@link createEffect} for side effects.
 *
 * WHEN NOT TO USE:
 * Not for values fully derived from other signals - use {@link createMemo}, which
 * caches and recomputes only on dependency change. Not for per-render throwaway
 * values.
 *
 * EDGE CASES:
 * - Functional setter: a function argument is always treated as an updater; to
 *   store a function AS the value, wrap it (setter(() => fn)).
 * - Equality short-circuit: mutating an object in place and setting the same
 *   reference is a no-op under Object.is; pass a fresh reference or a custom equals.
 * - Reading outside any tracking scope returns the value without subscribing.
 *
 * PERFORMANCE NOTES:
 * getter is O(1) plus one link insert when tracking. setter is O(1) on a no-op
 * (equality check only) and O(subscribers) on a real change. The subscriber-list
 * check skips notify() entirely when nothing is listening.
 *
 * DEVELOPER WARNING:
 * The equality function gates ALL notifications - a comparator that wrongly reports
 * equal silently freezes every dependent. The functional-setter detection keys off
 * typeof === 'function', so a function stored as a value must be wrapped.
 *
 * @typeParam T - The signal's value type.
 * @param initialValue - The starting value.
 * @param options - Optional settings; `options.equals` overrides the default
 *                   Object.is comparator.
 * @returns A [getter, setter] tuple ({@link Signal}).
 * @see {@link createMemo}
 * @see {@link createEffect}
 * @example
 * const [count, setCount] = createSignal(0);
 * setCount(n => n + 1);
 * count(); // 1
 *
 * // Custom equality: only notify when the integer part changes.
 * const [price, setPrice] = createSignal(9.99, {
 *     equals: (a, b) => Math.floor(a) === Math.floor(b)
 * });
 * setPrice(9.50); // no notification
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
            notify(producer);
        }
    };

    devtoolsId = dtRegister('signal', {
        name: options?.name,
        producer,
        getValue: (): unknown => value,
        setValue: (v: unknown): void => setter(v as T)
    });

    return [getter, setter];
}
