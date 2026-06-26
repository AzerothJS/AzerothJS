/**
 * MODULE: reactivity/types
 *
 * The reactive system's type contracts. The defining relationship is two-way: a
 * producer (signal/memo) tracks which consumers depend on it, and each consumer tracks
 * which producers it reads. Holding both directions is what makes precise, O(degree)
 * cleanup possible - a disposed consumer detaches from exactly the producers it read.
 *
 * The user-facing aliases (Getter/Setter/Signal/EffectFn/DisposeFn/EqualsFn and the
 * options interfaces) describe the public API shapes. The graph types (Producer, Link,
 * Subscriber) are @internal: they are the link-bookkeeping contract shared across the
 * primitive modules, exposed only because those modules pass them around.
 */

/**
 * A cleanup function returned from an effect (or registered via onCleanup). Runs before
 * the effect's next run and on its disposal.
 *
 * @example
 * createEffect(() => {
 *     const id = setInterval(tick, 1000);
 *     return () => clearInterval(id); // a CleanupFn
 * });
 */
export type CleanupFn = () => void;

/**
 * A producer node: anything consumers can subscribe to (a signal's value, a memo's
 * cached result, a selector key). Holds its subscriber links and a version that bumps
 * whenever its value actually changes.
 *
 * @internal
 */
export interface Producer
{
    /** Links to every subscribed consumer; each link records its slot here, so removal is one swap (no Set hashing on the hot path). */
    subs: Link[];

    /** With seenRun: which consumer's run last tracked this producer, so a repeated read in one run is two compares. */
    seenConsumer: Subscriber | null;

    /** The run stamp of that consumer's tracking run. */
    seenRun: number;

    /** Bumped whenever this producer's VALUE actually changes; consumers compare it against their links' recorded versions to detect real changes. */
    version: number;

    /** Present on memo producers (null otherwise): settle the memo (recompute if dirty) before its version is read, so a chain of clean memos costs version compares, not recomputes. Initialised in createProducer to keep one stable hidden class across all producers. */
    pull: (() => void) | null;

    /** Fired when the last subscriber unlinks; createSelector uses it to drop empty per-key producers (null otherwise). Initialised in createProducer for hidden-class stability. */
    onUnsubscribed: (() => void) | null;

    /** Devtools node id (set only while a devtools hook is attached), so the graph snapshot can map this producer back to its node. @internal */
    devtoolsId?: number;
}

/**
 * One edge of the reactive graph, held by BOTH sides: the consumer keeps its links in
 * read order, the producer in subscription order, and the link records its slot in
 * producer.subs for O(1) removal.
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
 * A reactive consumer (effect or memo) notified when producers it reads change. An
 * interface rather than a bare callback because it carries lifecycle metadata
 * (isDisposed, deps, cursor) alongside the callback. Dependencies are kept across runs
 * in read order, so a run reading the same producers in the same order touches no
 * links; disposal walks `deps` to detach from every producer in one pass.
 *
 * @internal
 */
export interface Subscriber
{
    /** Run when subscribed producers change. For an effect this is the SCHEDULER: outside a batch it runs the body now; inside one it queues for the flush. */
    execute: () => void;

    /** Present on effect nodes: run the body NOW, bypassing the batch/flush queue gate. The batch flush calls this to execute queued effects while writes they make are still deferred. @internal */
    runScheduled?: () => void;

    /** Whether this subscriber has been disposed. */
    isDisposed: boolean;

    /** Links to every producer this consumer reads, in read order. */
    deps: Link[];

    /** Position in `deps` during a tracked run; -1 outside a run. */
    cursor: number;

    /** Stamp of the current/most recent tracked run (see graph runClock). */
    activeRun: number;

    /** Present on memo nodes: invalidation entry point. notify() routes here instead of execute() so a memo marks itself stale (and propagates the possibility) without recomputing until read. `maybe` is true when the change arrived THROUGH another memo. */
    notifyDirty?: (maybe: boolean) => void;

    /** Error handler captured at construction (never re-read), or null when no catchError scope was active. Lets an effect created inside a catchError scope keep routing errors there after the scope unwinds. */
    errorHandler: ((error: unknown) => void) | null;

    /** Debug name from EffectOptions.name; surfaced by error tooling. */
    name?: string;

    /** Devtools node id (set only while a devtools hook is attached), so the graph snapshot can map this consumer back to its node. @internal */
    devtoolsId?: number;
}

/**
 * Reads and returns a signal/memo's current value. Called inside an effect or memo it
 * subscribes that consumer, which then re-runs when the value changes.
 *
 * @typeParam T - The value type.
 * @example
 * const [count] = createSignal(0);
 * count(); // 0 (also subscribes any active consumer)
 */
export type Getter<T> = () => T;

/**
 * Updates a signal's value. Accepts a new value directly, or a function that receives
 * the previous value. NOTE: to store a function AS the value, wrap it
 * (setView(() => MyComponent)) - the setter cannot tell "store this function" from
 * "use this function to compute the next value".
 *
 * @typeParam T - The value type.
 * @example
 * const [count, setCount] = createSignal(0);
 * setCount(5);                // direct value
 * setCount(prev => prev + 1); // function updater
 */
export type Setter<T> = (newValue: T | ((prev: T) => T)) => void;

/**
 * The tuple returned by createSignal: [getter, setter].
 *
 * @typeParam T - The value type.
 */
export type Signal<T> = [Getter<T>, Setter<T>];

/**
 * The function passed to createEffect. May return a {@link CleanupFn} that runs before
 * the next run and on dispose.
 */
export type EffectFn = () => void | CleanupFn;

/**
 * Disposes an effect: stops it running and unsubscribes it from every source.
 *
 * @example
 * const dispose = createEffect(() => console.log(count()));
 * dispose(); // effect stops, unsubscribed from all sources
 */
export type DisposeFn = () => void;

/**
 * Custom equality for signals/memos. The value is treated as unchanged (no
 * notification) when this returns true.
 *
 * @typeParam T - The value type.
 * @example
 * const [price, setPrice] = createSignal(9.99, {
 *     equals: (a, b) => Math.round(a) === Math.round(b)
 * });
 */
export type EqualsFn<T> = (prev: T, next: T) => boolean;

/**
 * Options for {@link Getter}-producing factories (createSignal, createMemo).
 *
 * @typeParam T - The value type.
 */
export interface SignalOptions<T>
{
    /** Custom equality; defaults to Object.is. */
    equals?: EqualsFn<T>;

    /** Optional debug name. */
    name?: string;
}

/**
 * Options for createEffect.
 */
export interface EffectOptions
{
    /** Optional debug name, surfaced by error tooling. */
    name?: string;
}

/**
 * Options for {@link createSelector}. An options object (rather than a positional `equals`) so the
 * selector matches the call shape of the other reactive factories - `createSignal`/`createMemo` take
 * `{ equals }`, and so does this; passing `{ equals }` to all three is the same everywhere.
 *
 * @typeParam T - The selected value type.
 */
export interface SelectorOptions<T>
{
    /** Custom equality for detecting a selection change; defaults to Object.is. */
    equals?: EqualsFn<T>;
}
