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
 * Devtools attribution carried on a producer/subscriber, attached only when
 * a devtools hook is installed at creation. It lives ON the node so the
 * devtools registry can hold the node by WeakRef alone (no strong ref that
 * would keep a GC-managed signal alive) while still reaching its id, source
 * owner, and value accessors. Absent (and zero-cost) in production.
 *
 * @internal
 */
export interface DevtoolsInfo
{
    /** Stable devtools node id (see devtools-hook nextDevtoolsId). */
    id: number;

    kind: 'signal' | 'effect' | 'memo' | 'root';

    /** Debug name from the create options, if any. */
    name?: string;

    /** Enclosing createRoot's devtools id at creation, or 0. */
    owner: number;

    /** Reads the node's current value (signals, memos). */
    peek?: () => unknown;

    /** Sets the node's value (signals only). */
    poke?: (value: unknown) => void;

    /** A memo node's own producer (for version + edge-source id). */
    producer?: Producer;
}

/**
 * A producer node in the reactive graph: anything consumers can subscribe
 * to (a signal's value, a memo's cached result, a selector key).
 *
 * @internal
 */
export interface Producer
{
    /** Devtools attribution; set only when a hook is installed. @internal */
    dv?: DevtoolsInfo;

    /** Links to every subscribed consumer. A link knows its slot here, so
     *  removal is one swap - no Set hashing on the hot path. */
    subs: Link[];

    /** Together with seenRun: which consumer's run last tracked this
     *  producer, so a repeated read in the same run is two compares. */
    seenConsumer: Subscriber | null;

    /** The run stamp of that consumer's tracking run. */
    seenRun: number;

    /**
     * Bumped every time this producer's VALUE actually changes (a signal
     * write that passes `equals`, a memo recompute that produces a new
     * value). Consumers compare it against their links' recorded versions
     * to decide whether anything they read really changed.
     */
    version: number;

    /**
     * Present on memo producers: settles the memo (recompute if dirty)
     * before its version is compared. Consumers call it during validation
     * so a chain of clean memos costs version compares, not recomputes.
     */
    pull?: () => void;

    /** Fired when the last subscriber unlinks; createSelector uses it to
     *  drop empty per-key producers from its map. */
    onUnsubscribed?: () => void;
}

/**
 * One edge of the reactive graph, held by BOTH sides: the consumer keeps
 * its links in read order, the producer in subscription order (with the
 * link recording its slot for O(1) removal).
 *
 * @internal
 */
export interface Link
{
    /** The producer this edge subscribes to. */
    producer: Producer;

    /** The consumer this edge notifies. */
    consumer: Subscriber;

    /** This link's index in producer.subs. */
    slot: number;

    /** The producer's version when the consumer last read it. */
    version: number;
}

/**
 * The internal representation of a reactive consumer (effect, memo) that gets
 * notified when producers it depends on change.
 *
 * It's an interface rather than a plain function because we need to carry
 * lifecycle metadata (isDisposed, deps) alongside the callback.
 *
 * Dependencies are kept across runs in read order: a run that reads the same
 * producers in the same order touches no links at all (see graph.ts), and
 * only links left unread at the end of a run are unlinked. Disposal walks
 * `deps` to remove the consumer from every producer in one pass.
 */
export interface Subscriber
{
    /** The function to execute when subscribed producers change */
    execute: () => void;

    /** Whether this subscriber has been disposed */
    isDisposed: boolean;

    /** Links to every producer this consumer reads, in read order. */
    deps: Link[];

    /** Position in `deps` during a tracked run; -1 outside a run. */
    cursor: number;

    /** Stamp of the current/most recent tracked run (see graph.ts runClock). */
    activeRun: number;

    /**
     * Present on memo nodes: invalidation entry point. notify() routes a
     * producer change here instead of execute(), so memos mark themselves
     * stale (and propagate the possibility downstream) without recomputing
     * until something reads them. `maybe` is true when the change arrived
     * THROUGH another memo - the upstream recompute may yet come out equal,
     * so the node only goes maybe-dirty and validates on pull.
     */
    notifyDirty?: (maybe: boolean) => void;

    /**
     * Error handler captured at subscriber-creation time. When this
     * subscriber's `execute()` throws, the error routes here instead of
     * propagating; `null` when no `catchError` scope was active at
     * construction. With no captured handler, the throw-time
     * `uncaughtErrorHandler` (catch-error.ts) is consulted before
     * propagating.
     *
     * Captured once, at construction, and never re-read - so an effect created
     * inside a `catchError` scope keeps routing errors to the same handler
     * even after the scope has unwound.
     *
     * @internal
     */
    errorHandler: ((error: unknown) => void) | null;

    /** Debug name from `EffectOptions.name`; surfaced by error tooling. */
    name?: string;

    /** Devtools attribution; set only when a hook is installed. @internal */
    dv?: DevtoolsInfo;
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

    /** Optional debug name, surfaced by devtools and error tooling. */
    name?: string;
}

/**
 * Options for createEffect.
 */
export interface EffectOptions
{
    /** Optional name for debugging purposes */
    name?: string;
}
