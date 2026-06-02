// Type definitions for the reactive system. The core relationship is two-way:
// a signal tracks which effects depend on it, and each effect tracks which
// signals it depends on. When a signal changes it notifies its effects, which
// re-run; tracking both directions is what makes precise cleanup possible.

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
 *     return () => clearInterval(id);  // a CleanupFn
 * });
 * ```
 */
export type CleanupFn = () => void;

/**
 * The internal representation of a reactive consumer (effect, memo) that gets
 * notified when signals it depends on change.
 *
 * It's an interface rather than a plain function because we need to carry
 * lifecycle metadata (isDisposed, dependencies) alongside the callback.
 *
 * The `dependencies` set is what makes cleanup cheap: without it, disposing an
 * effect would leave it in every signal's subscriber Set and leak. With it, we
 * can remove the subscriber from all its signals in one pass.
 */
export interface Subscriber
{
    /** The function to execute when subscribed signals change */
    execute: () => void;

    /** Whether this subscriber has been disposed */
    isDisposed: boolean;

    /**
     * Set of cleanup callbacks for all signals this subscriber
     * depends on. Each entry is a function that removes this
     * subscriber from one signal's subscriber Set.
     *
     * Called during cleanup to prevent memory leaks.
     */
    dependencies: Set<() => void>;

    /**
     * Error handler captured at subscriber-creation time. When this
     * subscriber's `execute()` throws, the error routes here instead of
     * propagating; `null` when no `catchError` scope was active at
     * construction.
     *
     * Captured once, at construction, and never re-read - so an effect created
     * inside a `catchError` scope keeps routing errors to the same handler
     * even after the scope has unwound.
     *
     * @internal
     */
    errorHandler: ((error: unknown) => void) | null;
}

/**
 * Reads and returns the current value of a signal. Called inside an effect or
 * memo, it subscribes that consumer, which then re-runs when the value changes.
 *
 * @typeParam T - The type of the signal's value
 *
 * @example
 * ```ts
 * const [count] = createSignal(0);
 * count();  // 0 (also subscribes any active effect)
 * ```
 */
export type Getter<T> = () => T;

/**
 * A setter function that updates a signal's value.
 *
 * Can accept either:
 *   - A new value directly: `setCount(5)`
 *   - A function that receives the previous value:
 *     `setCount(prev => prev + 1)`
 *
 * NOTE: When storing a function as a signal value, you must
 * wrap it: `setView(() => MyComponent)` because the setter
 * can't distinguish between "store this function" and "use
 * this function to compute the next value."
 *
 * @typeParam T - The type of the signal's value
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * setCount(5);                // Direct value
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
 * const [price, setPrice] = createSignal(9.99, {
 *   equals: (prev, next) => Math.round(prev) === Math.round(next)
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
