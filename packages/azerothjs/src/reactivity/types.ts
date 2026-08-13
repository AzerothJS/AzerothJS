/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The reactive system's type contracts. The dependency relationship is held in both
 * directions - a producer tracks the consumers that read it, a consumer tracks the
 * producers it reads - which is what makes cleanup exact: a disposed consumer detaches
 * from precisely the producers it read, and nothing else.
 *
 * Producer, Link and Subscriber are internal link bookkeeping, exposed only because the
 * primitive modules pass them between themselves.
 */

/**
 * A cleanup function returned from an effect, or registered with onCleanup. Runs before the
 * effect's next run and again when it is disposed, so every run tears down what the
 * previous one set up.
 *
 * @example
 * createEffect(() =>
 * {
 *     const id = setInterval(tick, 1000);
 *     return () => clearInterval(id);
 * });
 *
 * @see {@link EffectFn}
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
 * One edge of the reactive graph, held by both sides: the consumer keeps its links in read
 * order, the producer in subscription order, and the link records its own slot in
 * producer.subs so removal is a swap rather than a scan.
 *
 * @internal
 */
export interface Link
{
    producer: Producer;

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

    /** Debug name from EffectOptions.name; surfaced by error tooling. Explicit undefined is
     * equivalent to absent - constructors pass `options?.name` straight through. */
    name?: string | undefined;

    /** Devtools node id (set only while a devtools hook is attached), so the graph snapshot can map this consumer back to its node. @internal */
    devtoolsId?: number;
}

/**
 * Reads a signal or memo's current value. Called inside an effect or memo it also
 * subscribes that consumer, which then re-runs when the value changes; called anywhere
 * else it is a plain read and subscribes nothing.
 *
 * @typeParam T - The value type.
 * @returns The current value.
 * @example
 * const [count] = createSignal(0);
 * count(); // 0, and subscribes the active consumer if there is one
 */
export type Getter<T> = () => T;

/**
 * Writes a signal: either the next value, or a function computing it from the previous
 * one. A function argument is ALWAYS taken as that updater, so storing a function as the
 * value means wrapping it.
 *
 * @typeParam T - The value type.
 * @param newValue - The next value, or `(prev) => next`.
 * @example
 * setCount(5);                     // direct
 * setCount(prev => prev + 1);      // updater
 * setView(() => MyComponent);      // stores the function itself
 */
export type Setter<T> = (newValue: T | ((prev: T) => T)) => void;

/**
 * The `[getter, setter]` pair returned by createSignal.
 *
 * @typeParam T - The value type.
 * @example
 * const [count, setCount]: Signal<number> = createSignal(0);
 */
export type Signal<T> = [Getter<T>, Setter<T>];

/**
 * The function passed to createEffect. May return a {@link CleanupFn} that runs before the
 * next run and on dispose.
 *
 * An `async` body is accepted and its rejection routed to the enclosing error handler
 * (`catchError`, an ErrorBoundary, else `onUncaughtError`), so it cannot escape as an
 * unhandled rejection. It still tracks only the reads that happen SYNCHRONOUSLY: anything
 * read after the first `await` is invisible to the graph and will not re-run the effect.
 * An async body cannot register a cleanup either, since the returned promise is not a
 * {@link CleanupFn}. Prefer createResource for async data.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- the void union IS the contract: a plain void-bodied arrow must remain assignable, which `undefined | CleanupFn` would forbid
export type EffectFn = () => void | CleanupFn | Promise<void>;

/**
 * Stops an effect: it will not run again, and it is unsubscribed from every source.
 * Idempotent - calling it twice is not an error.
 *
 * @example
 * const dispose = createEffect(() => console.log(count()));
 * dispose();
 */
export type DisposeFn = () => void;

/**
 * Custom equality for signals and memos. Returning true means "unchanged", so no consumer
 * is notified; a comparator that wrongly reports equal silently freezes every dependent.
 *
 * @typeParam T - The value type.
 * @param prev - The current value.
 * @param next - The incoming value.
 * @returns True to suppress the notification.
 * @example
 * const [price, setPrice] = createSignal(9.99, {
 *     equals: (a, b) => Math.round(a) === Math.round(b)
 * });
 */
export type EqualsFn<T> = (prev: T, next: T) => boolean;

/**
 * Options shared by createSignal and createMemo.
 *
 * @typeParam T - The value type.
 */
export interface SignalOptions<T>
{
    /** Change comparator. Defaults to `Object.is`. */
    equals?: EqualsFn<T>;

    /** Debug name for devtools and error messages. Explicit `undefined` is the same as absent. */
    name?: string | undefined;
}

/** Options for createEffect. */
export interface EffectOptions
{
    /** Debug name, surfaced by error tooling. Explicit `undefined` is the same as absent. */
    name?: string | undefined;
}

/**
 * Options for createSelector. An options object rather than a positional `equals`, so
 * `{ equals }` means the same thing here as it does to createSignal and createMemo.
 *
 * @typeParam T - The selected value type.
 */
export interface SelectorOptions<T>
{
    /** Comparator deciding whether the selection changed. Defaults to `Object.is`. */
    equals?: EqualsFn<T>;

    /** Debug name for devtools; labels the selector's watcher effect. */
    name?: string;
}
