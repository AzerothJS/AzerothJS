/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A memo is a cached derived value, and both a consumer (it reads signals and memos) and a
 * producer (effects and other memos subscribe to it exactly as they would a signal).
 *
 * Memos are lazy, with one eager first compute so that a throwing compute reports at
 * creation and the memo holds a real value the moment createMemo returns. After that a
 * dependency change only MARKS the node - DIRTY when a signal it reads directly changed,
 * MAYBE_DIRTY when the change arrived through another memo whose own recompute may still
 * produce an equal value - and pushes that possibility downstream once. The recompute
 * itself waits for a read.
 *
 * A MAYBE_DIRTY memo settles its dependencies and compares their versions first, and
 * returns to CLEAN without recomputing when every upstream came out equal. That version
 * check is what keeps long derived chains cheap and stops a recompute that produced an
 * equal value from re-running its readers.
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
import { currentOwner, registerDisposer, setCurrentOwner, drainOwner } from './create-root.ts';
import type { Owner } from './create-root.ts';
import { currentErrorHandler, setCurrentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { assertFunction } from './validate.ts';
import { dtRegister, dtRun, dtDispose, dtEnabled } from './devtools.ts';

/** CLEAN: cached. MAYBE_DIRTY: an upstream memo changed, so validate. DIRTY: recompute. */
const CLEAN = 0;
const MAYBE_DIRTY = 1;
const DIRTY = 2;

/**
 * Creates a cached derived value. `compute` runs once immediately, then again only when a
 * read finds that a dependency actually changed; reads in between return the cache.
 *
 * A memo nobody reads never recomputes, however much its inputs churn. It also interposes
 * one producer between the sources and the readers, so readers depend on the memo rather
 * than on everything it reads, and a change that nets out equal stops at the memo instead
 * of cascading.
 *
 * `compute` must be pure. It must not write a signal it reads, which is a feedback loop,
 * and it must not read its own value, which throws immediately as a cycle.
 *
 * The first computed value is always accepted, so a custom `equals` never sees an
 * uninitialised placeholder. Afterwards the memo's version advances only when the new
 * value differs under `equals`, which is exactly what stops downstream readers re-running
 * for an unchanged result.
 *
 * Reading inside a batch is safe: the read settles the memo on demand, so it reflects the
 * writes that have already landed.
 *
 * @typeParam T - The computed value type.
 * @param compute - Derives the value from reactive sources. Pure, no side effects.
 * @param options - Optional settings.
 * @param options.equals - Change comparator. Defaults to `Object.is`. One that wrongly
 *                         reports equal freezes every downstream reader.
 * @param options.name - Debug name shown in devtools.
 * @returns A getter that settles the memo, subscribes the active consumer and returns the
 *          cached value.
 * @throws {TypeError} If `compute` is not a function.
 * @throws {Error} If `compute` reads the memo's own getter, which is a self-dependency.
 * @throws Whatever the first compute throws, when no error handler is installed. The node
 *         is torn down before the error propagates.
 * @example
 * const [price, setPrice] = createSignal(100);
 * const [quantity] = createSignal(2);
 *
 * const total = createMemo(() => price() * quantity());
 * total();      // 200
 * setPrice(50);
 * total();      // 100, recomputed once on this read, then cached
 *
 * @see {@link createSignal} for independently writable state.
 * @see {@link createEffect} for side effects.
 */
export function createMemo<T>(compute: () => T, options?: SignalOptions<T>): Getter<T>
{
    assertFunction(compute, 'createMemo', 'Pass the derivation as a function: createMemo(() => a() + b()).');

    const equals: EqualsFn<T> = options?.equals ?? Object.is;

    const producer = createProducer();

    let value: T;
    let hasValue = false;
    let state = DIRTY; // never computed yet
    let cleanups: CleanupFn[] = [];

    // A read of this memo from inside its own compute is a self-dependency. Detect it rather
    // than corrupt the tracking cursor with a re-entrant beginTrack and return a half-built
    // value.
    let computing = false;

    let devtoolsId = 0;

    // The scope this memo was created under, re-established around every recompute so anything
    // the compute creates is owned here and context reads resolve against this chain - not the
    // scope of whichever write happened to invalidate the memo.
    const owner: Owner = {
        disposers: [],
        parent: currentOwner,
        context: null,
        errorHandler: currentErrorHandler,
        disposed: false
    };

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

    // `maybe` (the change arrived via another memo) marks MAYBE_DIRTY and validates on pull; a
    // direct signal change marks DIRTY and recomputes on pull. The possibility propagates
    // downstream once per dirtying, but this memo's own version advances only if the eventual
    // recompute really produces a new value.
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

    // Recompute only if something really changed: MAYBE_DIRTY validates dependency versions
    // first, so an upstream that recomputed equal costs nothing here.
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

    function recompute(): void
    {
        if (computing)
        {
            throw new Error(
                'Cyclic memo: its compute read its own value, so it depends on itself. ' +
                'A memo must derive from other reactive sources, not from itself.'
            );
        }

        // Teardown of the previous compute runs with no subscriber and no cleanup array, so a
        // read inside a cleanup cannot link this memo - or whoever is ambient - to a producer it
        // never legitimately read. The work the last compute owned is then drained, not disposed:
        // this node has to survive for the next compute.
        {
            const teardownSubscriber = currentSubscriber;
            const teardownCleanups = currentCleanups;
            setCurrentSubscriber(null);
            setCurrentCleanups(null);
            try
            {
                if (cleanups.length > 0)
                {
                    const pending = cleanups;
                    cleanups = [];
                    for (const c of pending)
                    {
                        c();
                    }
                }
                drainOwner(owner);
            }
            finally
            {
                setCurrentSubscriber(teardownSubscriber);
                setCurrentCleanups(teardownCleanups);
            }
        }

        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(node);
        const previousCleanups = currentCleanups;
        setCurrentCleanups(cleanups);
        const previousOwner = setCurrentOwner(owner);
        const previousHandler = setCurrentErrorHandler(node.errorHandler);
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
            setCurrentErrorHandler(previousHandler);
            setCurrentOwner(previousOwner);
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

    // Consumers settle the memo on demand through Producer.pull during validation, which is
    // what keeps a clean chain at version-compare cost.
    producer.pull = pull;

    // Registered before the eager first compute so 'created' precedes the first 'run'. A memo is
    // both producer and consumer, so it carries both refs; its value is readable but not
    // writable from the panel.
    devtoolsId = dtEnabled() ? dtRegister('memo', { name: options?.name, producer, subscriber: node, getValue: (): unknown => value }) : 0;

    // If the eager first compute throws unabsorbed, the caller never receives a getter, so
    // nothing could dispose it. Tear down before rethrowing.
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

    // Idempotent.
    function dispose(): void
    {
        if (node.isDisposed)
        {
            return;
        }
        node.isDisposed = true;

        const teardownSubscriber = currentSubscriber;
        const teardownCleanups = currentCleanups;
        setCurrentSubscriber(null);
        setCurrentCleanups(null);
        try
        {
            const pending = cleanups;
            cleanups = [];
            for (const c of pending)
            {
                c();
            }
            owner.disposed = true;
            drainOwner(owner);
            owner.context = null;
        }
        finally
        {
            setCurrentSubscriber(teardownSubscriber);
            setCurrentCleanups(teardownCleanups);
        }

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
