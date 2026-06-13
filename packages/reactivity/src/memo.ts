// A memo is a computed value that caches its result and only recomputes when
// its signal dependencies change. It is both a consumer (reads signals) and a
// producer (other effects can subscribe to it like a signal).
//
// Memos are lazy two-state nodes with an EAGER FIRST COMPUTE. The initial
// compute runs at createMemo() - that keeps the creation-time contracts
// intact (a throwing compute routes to the catchError handler immediately;
// the memo holds its real value before createMemo returns). After that,
// a dependency change only MARKS the memo (dirty when a direct
// dependency's value changed, maybe-dirty when the change arrived through
// another memo) and pushes the possibility downstream; the recompute
// happens when something READS the memo. A maybe-dirty memo first settles
// its own dependencies and compares their versions, so a chain whose
// upstream recomputed to an equal value becomes clean again without
// recomputing.
//
// Consequences worth knowing:
//   - A memo nobody reads never RE-computes, no matter how often its
//     inputs change.
//   - Reading a memo always returns a value computed from CURRENT inputs -
//     including inside a batch(), where the old eager design returned a
//     stale value until the flush.
//   - Effects validate dependency versions before re-running (graph.ts
//     depsChanged), preserving the contract that a recompute gated by
//     `equals` does not re-run readers.

import type { Getter, SignalOptions, EqualsFn, Subscriber, CleanupFn } from './types.ts';
import {
    createProducer,
    track,
    notify,
    beginTrack,
    endTrack,
    unlinkAll,
    depsChanged,
    currentSubscriber,
    setCurrentSubscriber,
    currentCleanups,
    setCurrentCleanups
} from './graph.ts';
import { attachSubscriberProbe } from './signal.ts';
import { registerDisposer } from './create-root.ts';
import { currentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { devtoolsHook, nextDevtoolsId } from './devtools-hook.ts';

/** Invalidation states. @internal */
const CLEAN = 0;
const MAYBE_DIRTY = 1;
const DIRTY = 2;

/**
 * Creates a memoized computed value that recalculates only when its
 * dependencies change. Computation is lazy: it runs on the first read and
 * whenever a read finds a dependency actually changed; reads in between
 * return the cached value. Other effects depend on the memo by calling the
 * returned getter.
 *
 * @typeParam T - The type of the computed value
 *
 * @param compute - Computes the value from signals
 * @param options - Optional custom equality
 *
 * @returns A getter that returns the cached computed value
 *
 * Why: a plain compute function reruns its full body on every read and forces
 * each reader to subscribe to all the sources.
 *
 * Without createMemo: a bare function recomputes every time it is called:
 *
 *     const total = () => price() * quantity();
 *     total();
 *     total(); // multiplies again even though nothing changed
 *
 * With createMemo: the result is cached until a dependency actually changes:
 *
 *     const total = createMemo(() => price() * quantity());
 *     total();
 *     total(); // returns the cached value, no recompute
 *
 * @example
 * ```ts
 * const [price, setPrice] = createSignal(100);
 * const [quantity] = createSignal(2);
 * const total = createMemo(() => price() * quantity());
 *
 * total();        // 200
 * setPrice(50);
 * total();        // 100 (recomputed)
 * ```
 *
 * @example
 * ```ts
 * // Memos compose as dependencies of other memos and effects
 * const count = createMemo(() => items().length);
 * const isEmpty = createMemo(() => count() === 0);
 * ```
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    // The custom `equals` must never see the initial placeholder: a memo's
    // first computed value is always accepted, so an `equals` that
    // dereferences its arguments (e.g. `(a, b) => a.id === b.id`) is safe.
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    const producer = createProducer();

    let value: T;
    let hasValue = false;
    let state = DIRTY; // never computed yet
    let cleanups: CleanupFn[] = [];

    let debugId = 0;
    if (devtoolsHook)
    {
        debugId = nextDevtoolsId();
        devtoolsHook.created({ id: debugId, kind: 'memo', name: options?.name });
    }

    const node: Subscriber =
    {
        // execute() is the batch-queue/diagnostic entry; for a memo it just
        // re-marks (recompute stays read-driven).
        execute: (): void => markStale(false),
        isDisposed: false,
        deps: [],
        cursor: -1,
        activeRun: 0,
        notifyDirty: markStale,
        errorHandler: currentErrorHandler
    };

    /**
     * A dependency reported a change. `maybe` is true when it arrived via
     * another memo (whose recompute may yet come out equal) - the node only
     * goes maybe-dirty and validates dependency versions on pull. A direct
     * signal change is definite: dirty, recompute on pull.
     */
    function markStale(maybe: boolean): void
    {
        if (node.isDisposed)
        {
            return;
        }

        const target = maybe ? MAYBE_DIRTY : DIRTY;
        if (state >= target)
        {
            return;
        }

        const wasClean = state === CLEAN;
        state = target;

        if (wasClean)
        {
            // Push the POSSIBILITY downstream exactly once per dirtying:
            // dependent memos go maybe-dirty, dependent effects
            // validate-and-run. Our own version only advances if the
            // eventual recompute really produces a new value.
            notify(producer, true);
        }
    }

    /** Settles the memo: recompute if (and only if) something really changed. */
    function pull(): void
    {
        if (node.isDisposed || state === CLEAN)
        {
            return;
        }

        // Maybe-dirty: settle dependencies first; if every version is
        // unchanged the upstream recompute came out equal - nothing to do.
        if (state === MAYBE_DIRTY && hasValue && !depsChanged(node))
        {
            state = CLEAN;
            return;
        }

        recompute();
    }

    function recompute(): void
    {
        if (debugId !== 0 && devtoolsHook)
        {
            devtoolsHook.run(debugId);
        }

        if (cleanups.length > 0)
        {
            for (const c of cleanups)
            {
                c();
            }
            cleanups = [];
        }

        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(node);
        const previousCleanups = currentCleanups;
        setCurrentCleanups(cleanups);
        beginTrack(node);

        let next!: T;
        let failed = false;
        try
        {
            next = compute();
        }
        catch (err)
        {
            failed = true;
            if (node.errorHandler)
            {
                node.errorHandler(err);
            }
            else if (uncaughtErrorHandler)
            {
                uncaughtErrorHandler(err, { source: 'memo' });
            }
            else
            {
                throw err;
            }
        }
        finally
        {
            endTrack(node);
            setCurrentCleanups(previousCleanups);
            setCurrentSubscriber(previousSubscriber);
        }

        state = CLEAN;

        if (failed)
        {
            return;
        }

        // First value is always accepted; after that, the version advances
        // only when the value actually changed under `equals` - which is
        // what downstream validation checks.
        if (hasValue && equals(value, next))
        {
            return;
        }

        value = next;
        hasValue = true;
        producer.version++;
    }

    // Settling on demand is what makes chains cheap: consumers reach this
    // through Producer.pull during validation.
    producer.pull = pull;

    // Eager first compute: creation-time contracts (error routing, value
    // available immediately) predate the lazy model and are kept. If it
    // throws with no catchError handler, tear down before rethrowing - the
    // caller never gets a getter, so nothing could ever dispose the node.
    try
    {
        pull();
    }
    catch (err)
    {
        dispose();
        throw err;
    }

    registerDisposer(dispose);

    function dispose(): void
    {
        if (node.isDisposed)
        {
            return;
        }
        node.isDisposed = true;

        for (const c of cleanups)
        {
            c();
        }
        cleanups = [];

        unlinkAll(node);

        if (debugId !== 0 && devtoolsHook)
        {
            devtoolsHook.disposed(debugId);
        }
    }

    const getter: Getter<T> = (): T =>
    {
        pull();
        track(producer);
        return value;
    };

    attachSubscriberProbe(getter, (): number => producer.subs.length);

    return getter;
}
