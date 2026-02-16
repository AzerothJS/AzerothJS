// ============================================================================
// QUANTUM FRAMEWORK — Signal (Reactive State)
// ============================================================================
//
// A signal is a reactive value that notifies its subscribers
// when it changes. It's the atomic unit of state in Quantum.
//
// MEMORY MANAGEMENT:
//
//   Signals and effects have a TWO-WAY relationship:
//
//     Signal ──► knows which effects subscribe to it
//     Effect ──► knows which signals it depends on
//
//   When an effect is disposed:
//     1. Effect calls all its dependency cleanup functions
//     2. Each cleanup function removes the effect from that signal's Set
//     3. The effect is fully detached — no references remain
//     4. Garbage collector can free the memory
//
//   This prevents the memory leak where disposed effects stay
//   in signal subscriber Sets forever.
//
// ============================================================================

import type { Getter, Setter, Signal, Subscriber, SignalOptions, EqualsFn } from './types.ts';

/**
 * The currently running effect.
 *
 * When an effect runs, it sets this variable to itself.
 * When a signal's getter is called, it checks this variable
 * to know "who is reading me?" and subscribes that effect.
 *
 * Set to `null` when no effect is running (e.g., reading a
 * signal in regular code outside an effect).
 *
 * @internal Managed by createEffect, read by createSignal
 */
export let currentSubscriber: Subscriber | null = null;

/**
 * Sets the current subscriber.
 *
 * Called by createEffect before running the effect function,
 * and cleared after it finishes.
 *
 * @internal
 * @param sub - The subscriber to set, or null to clear
 */
export function setCurrentSubscriber(sub: Subscriber | null): void
{
    currentSubscriber = sub;
}

/**
 * Creates a reactive signal — a getter/setter pair that
 * automatically tracks dependencies and notifies subscribers.
 *
 * @typeParam T - The type of the signal's value
 *
 * @param initialValue - The starting value of the signal
 * @param options - Optional configuration (custom equality function)
 *
 * @returns A tuple [getter, setter] to read and write the value
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 *
 * count();  // → 0
 *
 * setCount(5);
 * count();  // → 5
 *
 * setCount(prev => prev + 1);
 * count();  // → 6
 * ```
 */
export function createSignal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T>
{
    let value: T = initialValue;
    const subscribers = new Set<Subscriber>();
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    const getter: Getter<T> = () =>
    {
        if (currentSubscriber !== null && !currentSubscriber.isDisposed)
        {
            subscribers.add(currentSubscriber);

            // Register a cleanup function on the subscriber
            // so it can remove itself from this signal later
            const sub = currentSubscriber;
            sub.dependencies.add(() =>
            {
                subscribers.delete(sub);
            });
        }

        return value;
    };

    const setter: Setter<T> = (newValue: T | ((prev: T) => T)) =>
    {
        const resolved = typeof newValue === 'function' ? (newValue as (prev: T) => T)(value) : newValue;

        if (equals(value, resolved))
        {
            return;
        }

        value = resolved;

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
