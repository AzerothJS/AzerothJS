/**
 * MODULE: reactivity/create-memo
 *
 * A memo is a cached derived value: it reads other reactive sources, caches the
 * result, and recomputes only when one of those sources actually changes. It is
 * both a consumer (it reads signals/memos) and a producer (effects and other memos
 * subscribe to it like a signal).
 *
 * SCHEDULING MODEL:
 * Memos are lazy two-state nodes with one eager first compute. The first value is
 * computed at createMemo() time so creation-time contracts hold (a throwing compute
 * routes to the error handler immediately, and the memo holds a real value before
 * it returns). After that a dependency change only MARKS the node - DIRTY when a
 * direct signal it reads changed, MAYBE_DIRTY when the change arrived through
 * another memo whose own recompute might still produce an equal value - and pushes
 * that possibility downstream once. The actual recompute is deferred until someone
 * READS the memo. A MAYBE_DIRTY memo first settles its dependencies and compares
 * their versions; if every upstream came out equal it returns to CLEAN without
 * recomputing. This version-based validation is what keeps long derived chains
 * cheap and prevents a recompute that produced an equal value from re-running its
 * readers.
 */

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
import { attachSubscriberProbe } from './create-signal.ts';
import { registerDisposer } from './create-root.ts';
import { currentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { assertFunction } from './validate.ts';
import { dtRegister, dtRun, dtDispose, dtEnabled } from './devtools.ts';

/** Invalidation states: CLEAN (cached), MAYBE_DIRTY (upstream memo changed - validate), DIRTY (recompute). @internal */
const CLEAN = 0;
const MAYBE_DIRTY = 1;
const DIRTY = 2;

/**
 * createMemo
 *
 * PURPOSE:
 * Creates a cached derived value. `compute` runs on the first read and again only
 * when a read finds that a dependency actually changed; reads in between return the
 * cached value. Other effects and memos depend on it by calling the returned getter.
 *
 * WHY IT EXISTS:
 * A plain derived function (`() => a() * b()`) recomputes its whole body on every
 * call AND forces each reader to subscribe to all of its sources directly. A memo
 * solves both: it caches the result, and it interposes one producer between the
 * sources and the readers so a source change is validated once and readers see a
 * single dependency. Without it, expensive derivations rerun needlessly and the
 * dependency graph fans out instead of staying layered.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. Compiled `.azeroth` `derived` declarations lower to
 * createMemo calls. The getter is read inside renderer bindings and other memos,
 * which is how it joins the dependency graph. In SSR/string mode the getter still
 * returns a correctly computed value (compute runs once, synchronously), but no
 * live subscription survives the render - reactivity resumes on the client during
 * hydrate().
 *
 * INPUT CONTRACT:
 * - compute: a pure function of reactive sources; its reads during a run become the
 *   memo's tracked dependencies. It must not write the signals it reads (that is a
 *   feedback loop) and should have no side effects.
 * - options.equals: optional comparator, defaults to Object.is. The first computed
 *   value is always accepted, so equals never sees an uninitialised placeholder.
 *
 * OUTPUT CONTRACT:
 * - Returns a getter. Calling it settles the memo (recomputing only if a dependency
 *   really changed) and returns the cached value, subscribing the active scope.
 *
 * WHY THIS DESIGN:
 * Lazy recompute (read-driven) means a memo nobody reads never recomputes, no
 * matter how often its inputs churn. The MAYBE_DIRTY / version-compare pass means a
 * change that propagates through an intermediate memo but nets out equal stops there
 * instead of cascading. The eager first compute preserves the invariant that a memo
 * holds a real value the instant createMemo returns.
 *
 * WHEN TO USE:
 * For any value derived from reactive sources that is read more than trivially, or
 * that several consumers share, or that gates downstream work by equality.
 *
 * WHEN NOT TO USE:
 * Not for independently writable state (use {@link createSignal}). Not for side
 * effects (use {@link createEffect}); compute must stay pure.
 *
 * EDGE CASES:
 * - A throwing compute routes to the enclosing catchError handler (or the global
 *   uncaught handler) and, on the eager first compute with no handler, tears the
 *   node down before rethrowing so a half-built memo never lingers.
 * - Inside batch(), reading the memo still returns a value computed from current
 *   inputs (the read settles it on demand).
 *
 * PERFORMANCE NOTES:
 * A cached read is O(1). A read after a MAYBE_DIRTY mark costs version compares over
 * the dependencies, not a recompute, when nothing truly changed. Recompute cost is
 * the body plus relinking only the dependencies whose read order changed.
 *
 * DEVELOPER WARNING:
 * compute must be pure and must not mutate its own dependencies. The version only
 * advances when the new value differs under equals, so an equals that wrongly
 * reports equal will freeze every downstream reader.
 *
 * @typeParam T - The computed value type.
 * @param compute - Pure function deriving the value from reactive sources.
 * @param options - Optional settings; `options.equals` overrides Object.is.
 * @returns A getter returning the cached computed value.
 * @see {@link createSignal}
 * @see {@link createEffect}
 * @example
 * const [price, setPrice] = createSignal(100);
 * const [quantity] = createSignal(2);
 * const total = createMemo(() => price() * quantity());
 * total();      // 200
 * setPrice(50);
 * total();      // 100 (recomputed once, then cached)
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    assertFunction(compute, 'createMemo', 'Pass the derivation as a function: createMemo(() => a() + b()).');

    // First computed value is always accepted, so a custom equals that dereferences
    // its arguments never sees an uninitialised placeholder.
    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    const producer = createProducer();

    let value: T;
    let hasValue = false;
    let state = DIRTY; // never computed yet
    let cleanups: CleanupFn[] = [];

    // True while compute() is on the stack. A read of this memo from within its own
    // compute is a cycle (the value depends on itself); detect it rather than corrupt
    // the tracking cursor with a re-entrant beginTrack and return a half-built value.
    let computing = false;

    // Devtools node id (0 unless a devtools hook is attached); used to emit run/dispose events.
    let devtoolsId = 0;

    const node: Subscriber =
    {
        // For a memo, execute() just re-marks; the recompute stays read-driven.
        execute: (): void => markStale(false),
        isDisposed: false,
        deps: [],
        cursor: -1,
        activeRun: 0,
        notifyDirty: markStale,
        errorHandler: currentErrorHandler
    };

    // A dependency changed. `maybe` (arrived via another memo) -> MAYBE_DIRTY and
    // validate on pull; a direct signal change -> DIRTY and recompute on pull. The
    // possibility is pushed downstream once per dirtying; our own version advances
    // only if the eventual recompute really produces a new value.
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
            notify(producer, true);
        }
    }

    // Settle the memo: recompute only if something really changed. MAYBE_DIRTY first
    // validates dependency versions, so an upstream that recomputed equal is a no-op.
    function pull(): void
    {
        if (node.isDisposed || state === CLEAN)
        {
            return;
        }

        if (state === MAYBE_DIRTY && hasValue && !depsChanged(node))
        {
            state = CLEAN;
            return;
        }

        recompute();
    }

    // Run compute under this node's tracking context, routing errors to the captured
    // handler; advance the version only when the value changed under equals.
    function recompute(): void
    {
        if (computing)
        {
            throw new Error(
                'Cyclic memo: its compute read its own value, so it depends on itself. ' +
                'A memo must derive from other reactive sources, not from itself.'
            );
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
        computing = true;

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
            computing = false;
            endTrack(node);
            setCurrentCleanups(previousCleanups);
            setCurrentSubscriber(previousSubscriber);
            if (devtoolsId !== 0)
            {
                dtRun(devtoolsId);
            }
        }

        state = CLEAN;

        if (failed)
        {
            return;
        }

        if (hasValue && equals(value, next))
        {
            return;
        }

        value = next;
        hasValue = true;
        producer.version++;
    }

    // Consumers settle the memo on demand through Producer.pull during validation;
    // this is what keeps clean chains at version-compare cost.
    producer.pull = pull;

    // Announce to devtools before the eager first compute, so 'created' precedes the first 'run'. A memo
    // is both a producer (other nodes subscribe to it) and a consumer (it reads sources), so it carries
    // both refs; its value is readable but not writable from the panel.
    devtoolsId = dtEnabled() ? dtRegister('memo', { name: options?.name, producer, subscriber: node, getValue: (): unknown => value }) : 0;

    // Eager first compute. If it throws with no catchError handler, tear down before
    // rethrowing - the caller never receives a getter, so nothing could dispose it.
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

    // Run cleanups and detach from every producer; idempotent.
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
        dtDispose(devtoolsId);
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
