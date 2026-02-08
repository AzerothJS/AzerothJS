// ============================================================================
// QUANTUM FRAMEWORK — Signal (Reactive State)
// ============================================================================
//
// The Signal is the most fundamental building block of Quantum's reactivity.
// It holds a value that can be read and written. When the value changes,
// all subscribers (effects, memos) are automatically notified.
//
// This file exports:
//   - createSignal()     — Creates a reactive signal
//   - getCurrentEffect() — Gets the currently tracking effect (internal)
//   - setCurrentEffect() — Sets the currently tracking effect (internal)
//
// INTERNAL ARCHITECTURE:
//
//   createSignal(initialValue)
//         │
//         ├── read()  — Returns value, tracks current effect as subscriber
//         └── write() — Updates value, notifies all subscribers
//
//   The tracking works through a module-level variable `currentEffect`:
//     1. An effect starts running → sets currentEffect = itself
//     2. Effect calls signal.read() → signal sees currentEffect → adds it
//     3. Effect finishes → clears currentEffect
//     4. Signal.write() called → loops subscribers → re-runs effects
//
// ============================================================================

import type { Getter, Setter, Signal, SignalOptions, Subscriber } from './types.js';

// ============================================================================
// EFFECT TRACKING
// ============================================================================

/**
 * The currently running effect that is tracking signal dependencies.
 *
 * - `null` when no effect is running (reads won't track)
 * - Set to an effect's subscriber function when that effect is executing
 *
 * @internal Managed by effect.ts, read by signal.ts
 */
let currentEffect: Subscriber | null = null;

/**
 * Returns the currently running effect.
 *
 * Used by {@link createEffect} in effect.ts to save and restore
 * the parent effect when effects are nested inside each other.
 *
 * @internal This is an internal API — not exposed to framework users.
 *
 * @returns The current tracking effect, or null if none is active
 */
export function getCurrentEffect(): Subscriber | null
{
    return currentEffect;
}

/**
 * Sets the currently running effect.
 *
 * Called by {@link createEffect} in effect.ts to register which
 * effect is currently executing, so signals can track it.
 *
 * @internal This is an internal API — not exposed to framework users.
 *
 * @param effect - The effect to set as current tracker, or null to clear
 */
export function setCurrentEffect(effect: Subscriber | null): void
{
    currentEffect = effect;
}

// ============================================================================
// CREATE SIGNAL
// ============================================================================

/**
 * Creates a reactive signal — a piece of state that can be tracked.
 *
 * A signal stores a value and keeps track of which effects depend on it.
 * When the value changes, all dependent effects are automatically
 * re-executed. This is the foundation of Quantum's reactivity system.
 *
 * @typeParam T - The type of value stored in the signal.
 *               Inferred automatically from the initial value.
 *
 * @param initialValue - The starting value of the signal
 * @param options - Optional configuration (equality function, debug name)
 *
 * @returns A {@link Signal} tuple of `[getter, setter]`
 *
 * @example
 * ```ts
 * // Basic usage:
 * const [count, setCount] = createSignal(0);
 * console.log(count());  // 0
 * setCount(5);
 * console.log(count());  // 5
 *
 * // Functional updates:
 * setCount(prev => prev + 1);
 * console.log(count());  // 6
 *
 * // With options:
 * const [user, setUser] = createSignal({ name: 'Alice', age: 30 }, { equals: false });
 *
 * // Automatic tracking with effects:
 * createEffect(() =>
 * {
 *     console.log(count());  // Re-runs whenever count changes
 * });
 * ```
 */
export function createSignal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T>
{
    let value: T = initialValue;

    /** Set of effects that depend on (read) this signal */
    const subscribers = new Set<Subscriber>();

    const equals = options?.equals === false ? () => false : (options?.equals ?? Object.is);

    const read: Getter<T> = (): T =>
    {
        if (currentEffect)
        {
            subscribers.add(currentEffect);
        }

        return value;
    };

    const write: Setter<T> = (nextValue: T | ((prev: T) => T)): void =>
    {
        const newValue = typeof nextValue === 'function' ? (nextValue as (prev: T) => T)(value) : nextValue;

        if (equals(value, newValue))
        {
            return;
        }

        value = newValue;

        for (const subscriber of subscribers)
        {

            subscriber();
        }
    };

    return [read, write];
}
