// ============================================================================
// QUANTUM FRAMEWORK — Reactivity Type Definitions
// ============================================================================
//
// These types define the foundation of Quantum's reactive system.
//
// ARCHITECTURE:
//
//   Signal ──────► Effect
//   (state)        (side effect)
//     │               │
//     │  subscribes   │
//     ◄───────────────┘
//     │
//     │  notifies on change
//     ├───────────────►  Effect re-runs
//     ├───────────────►  Effect re-runs
//     └─────────────��─►  Effect re-runs
//
//   Each signal tracks which effects depend on it.
//   Each effect tracks which signals it depends on.
//   This two-way tracking enables proper cleanup.
//
// ============================================================================

/**
 * A cleanup function returned from an effect.
 *
 * Called before the effect re-runs and when the effect is disposed.
 * Use this to clean up resources created by the previous run.
 *
 * @example
 * ```ts
 * createEffect(() =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);  // ← CleanupFn
 * });
 * ```
 */
export type CleanupFn = () => void;

/**
 * A subscriber function that gets called when a signal changes.
 *
 * This is the internal representation of a reactive subscriber.
 * It includes metadata for lifecycle management.
 */
export interface Subscriber
{
    /** The function to execute when subscribed signals change */
    execute: () => void;

    /** Whether this subscriber has been disposed */
    isDisposed: boolean;

    /**
     * Set of cleanup callbacks for all signals this subscriber depends on.
     * Each entry is a function that removes this subscriber from a signal's
     * subscriber set. Called during cleanup to prevent memory leaks.
     *
     * WHY THIS EXISTS:
     *   Without this, disposing an effect leaves it in every signal's
     *   subscriber Set → memory leak. With this, we can remove it
     *   from ALL signals it was subscribed to in one call.
     */
    dependencies: Set<() => void>;
}

/**
 * A getter function that reads and returns the current value of a signal.
 *
 * When called inside an effect or memo, it automatically subscribes
 * that effect to this signal — the effect will re-run when the
 * signal's value changes.
 *
 * @typeParam T - The type of the signal's value
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * count();  // → 0 (also subscribes any active effect)
 * ```
 */
export type Getter<T> = () => T;

/**
 * A setter function that updates a signal's value.
 *
 * Can accept either:
 *   - A new value directly: `setCount(5)`
 *   - A function that receives the previous value: `setCount(prev => prev + 1)`
 *
 * @typeParam T - The type of the signal's value
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * setCount(5);              // Direct value
 * setCount(prev => prev + 1); // Function updater
 * ```
 */
export type Setter<T> = (newValue: T | ((prev: T) => T)) => void;

/**
 * The tuple returned by createSignal: [getter, setter].
 *
 * @typeParam T - The type of the signal's value
 */
export type Signal<T> = [Getter<T>, Setter<T>];

/**
 * The function passed to createEffect.
 *
 * Can optionally return a cleanup function that runs before
 * the effect re-runs or when the effect is disposed.
 */
export type EffectFn = () => void | CleanupFn;

/**
 * A function that disposes an effect, stopping it from running
 * and cleaning up all its subscriptions.
 *
 * @example
 * ```ts
 * const dispose = createEffect(() =>
 * {
 *     console.log(count());
 * });
 *
 * dispose();  // Effect stops, unsubscribes from all signals
 * ```
 */
export type DisposeFn = () => void;

/**
 * Custom equality function for signals.
 *
 * If provided, the signal will only notify subscribers when
 * this function returns false (values are NOT equal).
 *
 * @typeParam T - The type of the signal's value
 *
 * @example
 * ```ts
 * // Only update when the rounded value changes
 * const [price, setPrice] = createSignal(9.99, {
 *   equals: (prev, next) => Math.round(prev) === Math.round(next),
 * });
 * ```
 */
export type EqualsFn<T> = (prev: T, next: T) => boolean;

/**
 * Options for createSignal.
 *
 * @typeParam T - The type of the signal's value
 */
export interface SignalOptions<T>
{
    /** Custom equality function. Defaults to Object.is */
    equals?: EqualsFn<T>;
}

/**
 * Options for createEffect.
 */
export interface EffectOptions
{
    /** Optional name for debugging purposes */
    name?: string;
}
