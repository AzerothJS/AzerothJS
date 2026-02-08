// ============================================================================
// QUANTUM FRAMEWORK — Reactivity Type Definitions
// ============================================================================
//
// This file contains all the core type definitions for Quantum's reactivity
// system. These types are the foundation that every other module builds upon.
//
// ARCHITECTURE OVERVIEW:
//
//   Signal (state)  ──→  Effect (side effect)  ──→  DOM Update
//   [Getter, Setter]     runs automatically         (renderer)
//
//   1. A Signal holds a reactive value (Getter reads, Setter writes)
//   2. An Effect is a function that re-runs when its signals change
//   3. The renderer (built later) connects signals to actual DOM nodes
//
// USAGE:
//   import type { Signal, Getter, Setter } from 'quantumjs';
//
//   These types are re-exported from the main package entry point,
//   so users never need to import from this file directly.
// ============================================================================

/**
 * A cleanup function returned by an effect.
 *
 * When an effect sets up external resources (timers, event listeners,
 * subscriptions, network connections, etc.), it should return a cleanup
 * function to tear them down before the effect re-runs or is disposed.
 *
 * Without cleanup, each re-run would create NEW resources without
 * removing the old ones, causing memory leaks.
 *
 * @example
 * ```ts
 * // Effect that sets up a timer — cleanup stops it
 * createEffect(() =>
 * {
 *     const id = setInterval(() => console.log('tick'), 1000);
 *     return () => clearInterval(id); // ← CleanupFn
 * });
 *
 * // Effect that adds an event listener — cleanup removes it
 * createEffect(() =>
 * {
 *     const handler = () => console.log('clicked');
 *     window.addEventListener('click', handler);
 *     return () => window.removeEventListener('click', handler); // ← CleanupFn
 * });
 * ```
 *
 * @see {@link EffectFn} — The effect function type that can return this
 * @see {@link createEffect} — The function that accepts effects with cleanup
 */
export type CleanupFn = () => void;

/**
 * A getter function that reads a reactive signal's current value.
 *
 * Calling a getter inside a running effect automatically subscribes
 * that effect to the signal. When the signal's value changes later,
 * the effect will re-run. This is called "automatic dependency tracking"
 * and is the core mechanism of Quantum's reactivity.
 *
 * @typeParam T - The type of value this getter returns
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * // count is Getter<number>
 *
 * count(); // Returns 0
 *
 * // Inside an effect, reading a getter creates a subscription:
 * createEffect(() =>
 * {
 *     console.log(count()); // Subscribes to count, re-runs on change
 * });
 *
 * setCount(5); // Effect re-runs, logs 5
 * ```
 *
 * @see {@link Signal} — The tuple that contains a Getter and Setter pair
 * @see {@link createSignal} — The function that creates a Getter
 * @see {@link createMemo} — Creates a computed Getter derived from other signals
 */
export type Getter<T> = () => T;

/**
 * A setter function that updates a reactive signal's value.
 *
 * Accepts either a direct new value OR a function that computes the
 * new value from the previous one. After updating, all subscribed
 * effects are notified and re-run.
 *
 * @typeParam T - The type of value this setter accepts
 *
 * @param value - The new value, or a function that receives the previous
 *                value and returns the new value
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * // setCount is Setter<number>
 *
 * // Direct value:
 * setCount(5);                  // count() is now 5
 * setCount(100);                // count() is now 100
 *
 * // Functional update (uses previous value):
 * setCount(prev => prev + 1);   // count() is now 101
 * setCount(prev => prev * 2);   // count() is now 202
 *
 * // Why use functional updates?
 * // When the new value depends on the old value, functional
 * // updates guarantee you're working with the latest value,
 * // even if multiple updates happen in quick succession.
 * ```
 *
 * @see {@link Signal} — The tuple that contains a Getter and Setter pair
 * @see {@link createSignal} — The function that creates a Setter
 */
export type Setter<T> = (value: T | ((prev: T) => T)) => void;

/**
 * A reactive signal — a tuple (fixed-size array) of [Getter, Setter].
 *
 * Signals are the fundamental unit of state in Quantum. They hold a
 * value that can be read reactively (via the Getter) and updated
 * (via the Setter). This is what {@link createSignal} returns.
 *
 * The tuple design allows clean destructuring with custom names:
 *
 * @typeParam T - The type of value stored in this signal
 *
 * @example
 * ```ts
 * // Destructure into any names you want:
 * const [count, setCount] = createSignal(0);
 * const [userName, setUserName] = createSignal('Alice');
 * const [isOpen, setIsOpen] = createSignal(false);
 * const [items, setItems] = createSignal<string[]>([]);
 *
 * // Position 0 = Getter (read)
 * // Position 1 = Setter (write)
 * count();       // read  → 0
 * setCount(5);   // write → count() now returns 5
 * ```
 *
 * @see {@link Getter} — The read function at position 0
 * @see {@link Setter} — The write function at position 1
 * @see {@link createSignal} — The function that creates a Signal
 */
export type Signal<T> = [Getter<T>, Setter<T>];

/**
 * A subscriber function that gets called when a signal's value changes.
 *
 * Subscribers are stored internally by each signal. When a signal's
 * value is updated via its Setter, the signal iterates through its
 * subscriber set and calls each one, triggering re-execution.
 *
 * In practice, subscribers are the internal wrapper functions created
 * by {@link createEffect}. You won't create subscribers directly —
 * the reactivity system manages them automatically.
 *
 * @internal This type is primarily used within the reactivity internals
 *           (signal.ts, effect.ts, batch.ts) rather than by end users.
 *
 * @example
 * ```ts
 * // Internally, when you write:
 * createEffect(() =>
 * {
 *     console.log(count());
 * });
 *
 * // The system creates a Subscriber (the effect wrapper) and adds it
 * // to count's internal subscriber set. When count changes:
 * setCount(5);
 * // → count loops through its subscribers → calls each one
 * // → the effect re-runs → reads count() → gets 5
 * ```
 *
 * @see {@link createEffect} — Creates effects that become subscribers
 * @see {@link createSignal} — Signals that manage subscriber sets
 */
export type Subscriber = () => void;

/**
 * A function that runs as a reactive side effect.
 *
 * Effect functions can optionally return a {@link CleanupFn} that will
 * be called before the effect re-runs or when it is disposed. If the
 * effect doesn't need cleanup, it can return nothing (void).
 *
 * @returns Either nothing (void) or a cleanup function that will be
 *          called before the next re-execution or on disposal
 *
 * @example
 * ```ts
 * // EffectFn that returns void (no cleanup needed):
 * const logEffect: EffectFn = () =>
 * {
 *     console.log('Current count:', count());
 * };
 *
 * // EffectFn that returns a CleanupFn:
 * const timerEffect: EffectFn = () =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id); // ← CleanupFn returned
 * };
 *
 * // Both are valid arguments to createEffect:
 * createEffect(logEffect);
 * createEffect(timerEffect);
 * ```
 *
 * @see {@link CleanupFn} — The cleanup function type
 * @see {@link createEffect} — The function that accepts an EffectFn
 */
export type EffectFn = () => void | CleanupFn;

/**
 * A comparison function that determines if two values are equal.
 *
 * Used by signals to decide whether an update should notify subscribers.
 * If the function returns true ("values are equal"), the signal skips
 * notification — preventing unnecessary effect re-runs and DOM updates.
 *
 * @typeParam T - The type of values being compared
 *
 * @param prev - The current (old) value of the signal
 * @param next - The proposed new value being set
 * @returns `true` if the values should be considered equal (skip update),
 *          `false` if they are different (proceed with update)
 *
 * @example
 * ```ts
 * // Default behavior (Object.is):
 * Object.is(1, 1);         // true  → skip update
 * Object.is(1, 2);         // false → notify subscribers
 * Object.is({}, {});       // false → different references!
 *
 * // Custom equality for objects (compare by content):
 * const deepEquals: EqualsFn<User> = (prev, next) =>
 * {
 *     return prev.id === next.id && prev.name === next.name;
 * };
 *
 * const [user, setUser] = createSignal(initialUser, { equals: deepEquals });
 * ```
 *
 * @see {@link SignalOptions} — Where this function is passed as an option
 * @see {@link createSignal} — The function that uses this for comparisons
 */
export type EqualsFn<T> = (prev: T, next: T) => boolean;

/**
 * Configuration options for {@link createSignal}.
 *
 * All properties are optional. If no options are provided, the signal
 * uses sensible defaults (Object.is for equality, no debug name).
 *
 * @typeParam T - The type of value stored in the signal
 *
 * @example
 * ```ts
 * // No options (uses defaults):
 * const [count, setCount] = createSignal(0);
 *
 * // With custom equality:
 * const [user, setUser] = createSignal(initialUser, { equals: (prev, next) => prev.id === next.id });
 *
 * // Always notify on set (even if value is the same):
 * const [data, setData] = createSignal(initialData, { equals: false });
 *
 * // With debug name:
 * const [count, setCount] = createSignal(0, { name: 'todo-count' });
 * ```
 *
 * @see {@link createSignal} — The function that accepts these options
 * @see {@link EqualsFn} — The custom equality function type
 */
export interface SignalOptions<T>
{
    /**
     * Custom equality function to determine if a signal's value has changed.
     *
     * - `undefined` (default): Uses `Object.is` for comparison.
     *   Works well for primitives (numbers, strings, booleans).
     *   For objects, only considers them equal if they are the
     *   exact same reference in memory.
     *
     * - `EqualsFn<T>`: A custom function that compares old and new values.
     *   Useful for deep comparison of objects or arrays.
     *
     * - `false`: Disables equality checking entirely. Every call to the
     *   setter will notify subscribers, even if the value hasn't changed.
     *   Useful when you want to force reactivity on object mutations.
     */
    equals?: EqualsFn<T> | false;

    /**
     * A debug name for this signal.
     *
     * Used in development-mode error messages and debugging tools
     * to help identify which signal is involved in an issue.
     *
     * Has no effect on runtime behavior or production builds.
     */
    name?: string;
}

/**
 * Configuration options for {@link createEffect}.
 *
 * @example
 * ```ts
 * // Default: effect runs immediately
 * createEffect(() =>
 * {
 *     console.log(count()); // Logs "0" right away
 * });
 *
 * // Deferred: effect only runs when a dependency changes
 * createEffect(() =>
 * {
 *     console.log(count()); // Does NOT log on creation
 * }, { defer: true });
 *
 * setCount(1); // NOW it logs "1" (first run)
 * ```
 *
 * @see {@link createEffect} — The function that accepts these options
 */
export interface EffectOptions
{
    /**
     * If `true`, the effect will NOT run immediately upon creation.
     * It will only execute for the first time when one of its
     * dependencies changes.
     *
     * Default: `false` (effect runs immediately)
     *
     * Use this when you only care about CHANGES to a value,
     * not its initial state. Common use cases:
     * - Sending analytics when a value changes
     * - Showing a notification when data updates
     * - Triggering animations on state transitions
     */
    defer?: boolean;
}
