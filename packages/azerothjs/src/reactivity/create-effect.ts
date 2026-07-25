/**
 * MODULE: reactivity/create-effect
 *
 * An effect is the bridge between reactive state and the outside world (DOM writes,
 * logging, network, subscriptions). It runs a function immediately, tracks every
 * reactive source that function reads, and re-runs whenever one of them changes.
 *
 * TRACKING MODEL:
 * During a run, signal/memo getters link this effect to their producer in read
 * order (see ./graph). Dependencies are NOT torn down and rebuilt each run: a run
 * that reads the same sources in the same order touches no links at all (one compare
 * per read), and only the links the run stopped reading are pruned afterwards. This
 * keeps steady-state re-runs allocation-free.
 *
 * SCHEDULING MODEL:
 * Outside a batch an effect runs synchronously on change. Inside batch() it is
 * queued and flushed once, so a burst of writes coalesces into a single run. Before
 * any re-run the effect validates its dependency versions (depsChanged): a
 * notification that arrived through a memo whose recompute came out equal, or a
 * batch that netted back to the same values, is skipped - the body never runs and
 * cleanups never fire.
 */

import type { EffectFn, DisposeFn, CleanupFn, Subscriber, EffectOptions } from './types.ts';
import {
    currentSubscriber,
    setCurrentSubscriber,
    currentCleanups,
    setCurrentCleanups,
    beginTrack,
    endTrack,
    unlinkAll,
    depsChanged
} from './graph.ts';
import { isBatching, queueEffect } from './batch.ts';
import { isStringMode } from './render-mode.ts';
import { registerDisposer } from './create-root.ts';
import { currentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { assertFunction } from './validate.ts';
import { dtRegister, dtRun, dtDispose, dtEnabled } from './devtools.ts';

/**
 * Cap on consecutive self-triggered re-runs of one effect before we declare a feedback
 * loop. Convergent self-writes (ErrorBoundary catch->setState->fallback) settle in 1-2
 * rounds; this generous bound only ever trips on a genuine cycle. @internal
 */
const MAX_SELF_RERUNS = 1000;

/**
 * createEffect
 *
 * PURPOSE:
 * Runs `fn` immediately, subscribes it to every reactive source it reads, and
 * re-runs it whenever any of them changes. Returns a dispose function that stops the
 * effect and unsubscribes it from every source.
 *
 * WHY IT EXISTS:
 * Reactive side effects must subscribe to each source they read and unsubscribe from
 * all of them on teardown. Doing that by hand (`a.subscribe(update); b.subscribe(...)`)
 * is where leaks come from - one missed unsubscribe keeps a closure (and whatever it
 * captures) alive forever. createEffect makes the read itself the subscription and
 * collapses teardown to a single dispose() call.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. It is the engine behind every renderer binding: the
 * compiler's emitted output wires DOM updates through effects, and `.azeroth`
 * `effect` blocks lower to createEffect. In SSR/string mode the body is NOT run -
 * an effect is a side effect with no DOM and no client on the server - so SSR stays
 * free of DOM access; the effect runs on the client when the component re-executes
 * during hydrate().
 *
 * INPUT CONTRACT:
 * - fn: the effect body. It may return a cleanup function, which runs before each
 *   re-run and on dispose. Reads inside fn become its tracked dependencies.
 * - options.name: optional label surfaced by error tooling.
 *
 * OUTPUT CONTRACT:
 * - Returns a dispose function. Calling it fires any pending cleanup, marks the
 *   effect disposed, and unlinks it from every producer. Idempotent.
 *
 * WHY THIS DESIGN:
 * Read-order link reuse makes the common case (re-run reads the same sources) cost
 * nothing in allocation. Validate-before-run avoids spurious re-runs from equal-value
 * propagation. Capturing the error handler at creation (not per run) keeps an effect
 * created inside a catchError scope routing to that handler even after the scope
 * unwinds.
 *
 * WHEN TO USE:
 * For bridging reactive state to imperative work: DOM mutation, subscriptions,
 * timers, logging, imperative third-party APIs.
 *
 * WHEN NOT TO USE:
 * Not for deriving values (use {@link createMemo}, which caches and does not re-run
 * readers). Avoid writing, inside an effect, a signal the same effect reads - that
 * is a self-triggering feedback loop.
 *
 * EDGE CASES:
 * - If the first run throws with no catchError handler, the effect is torn down
 *   before the throw propagates, so a half-subscribed effect never lingers.
 * - Returning a cleanup is optional; most effects never register one, so the cleanup
 *   array is not reallocated when empty.
 * - In string mode the function returns a disposer immediately without running fn.
 *
 * PERFORMANCE NOTES:
 * Steady-state re-runs are allocation-free when read order is stable. A queued
 * (batched) effect runs at most once per flush. Validation is version compares over
 * the dependency list, short-circuiting before the body.
 *
 * DEVELOPER WARNING:
 * Always dispose effects you create outside a createRoot/component scope, or they
 * (and everything they capture) leak. A cleanup function must be idempotent-safe -
 * it runs before every re-run, not only on dispose.
 *
 * @param fn - The effect body; may return a cleanup function.
 * @param options - Optional settings; `options.name` labels the effect for tooling.
 * @returns A dispose function that stops the effect and unsubscribes it.
 * @see {@link createSignal}
 * @see {@link createMemo}
 * @see {@link onCleanup}
 * @example
 * const [count, setCount] = createSignal(0);
 * const dispose = createEffect(() => console.log('Count:', count()));
 * // logs "Count: 0" immediately
 * setCount(5);  // logs "Count: 5"
 * dispose();
 * setCount(10); // nothing logged - disposed
 *
 * // With cleanup:
 * createEffect(() => {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);
 * });
 */
export function createEffect(fn: EffectFn, options?: EffectOptions): DisposeFn
{
    assertFunction(fn, 'createEffect', 'Pass the effect body as a function: createEffect(() => { ... }).');

    // Cleanups for the current run, from onCleanup() and from fn()'s return value;
    // all run before re-execution and on dispose.
    let cleanups: CleanupFn[] = [];

    // False only for the initial (unconditional) run; later runs validate versions first.
    let hasRun = false;

    // True while this effect's body is on the call stack. A re-trigger that arrives
    // WHILE running (the body, or something downstream, wrote a signal this effect
    // reads) must NOT re-enter synchronously - that would corrupt this run's tracking
    // cursor. Instead we record the re-trigger and re-run after the current body
    // unwinds. A convergent self-write (e.g. ErrorBoundary catching, setting error
    // state, then rendering the fallback) settles in a round or two; a divergent one
    // (`setX(x() + 1)`) never settles and is caught by the round cap below.
    let running = false;
    let rerunPending = false;

    // Devtools node id (0 unless a devtools hook is attached); used to emit run/dispose events.
    let devtoolsId = 0;

    const subscriber: Subscriber =
    {
        // execute() is the SCHEDULER (notify routes here): run now, or queue if batching.
        execute: schedule,
        // runScheduled() is the ungated body the batch flush invokes directly.
        runScheduled: runBody,
        isDisposed: false,
        deps: [],
        cursor: -1,
        activeRun: 0,
        // Captured once - see types.ts Subscriber.errorHandler for why it is not re-read.
        errorHandler: currentErrorHandler,
        name: options?.name
    };

    // Scheduler: what a change notification triggers. Outside a batch the body runs
    // immediately; inside one (including DURING a batch flush) it is queued so a burst
    // of writes - or writes made BY a flushing effect - coalesce into one run on
    // consistent state rather than re-entering the flush synchronously.
    function schedule(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        if (isBatching())
        {
            queueEffect(subscriber);
            return;
        }

        runBody();
    }

    function runBody(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        // Re-trigger arrived while the body is still on the stack: defer it rather than
        // re-enter (re-entry would reset this run's tracking cursor mid-flight). The
        // loop below re-runs once the current body unwinds.
        if (running)
        {
            rerunPending = true;
            return;
        }

        // Validate before any work: settle memo deps and compare versions. A change
        // that netted out equal (via a memo or a coalesced batch) is skipped here.
        if (hasRun && !depsChanged(subscriber))
        {
            return;
        }

        // Re-run while a self-write keeps re-triggering. A healthy convergent loop ends
        // in 1-2 rounds; an unbounded one (a true feedback cycle) trips the cap and
        // throws a precise error instead of overflowing the stack.
        let rounds = 0;
        do
        {
            rerunPending = false;
            runOnce();
            if (++rounds > MAX_SELF_RERUNS)
            {
                rerunPending = false;
                throw new Error(
                    `Cyclic effect${ subscriber.name ? ` "${ subscriber.name }"` : '' }: it kept ` +
                    `writing a signal it reads, re-triggering itself ${ MAX_SELF_RERUNS }+ times ` +
                    'without settling. Read the current value with untrack(), derive it with ' +
                    'createMemo(), or guard the write so it cannot run every time.'
                );
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runOnce() -> fn() -> schedule() mutates both flags through the closure; the rule's flow analysis cannot see it
        while (rerunPending && !subscriber.isDisposed);
    }

    function runOnce(): void
    {
        if (cleanups.length > 0)
        {
            for (const c of cleanups)
            {
                c();
            }
            cleanups = [];
        }

        // Install this subscriber + cleanup array as the active context (saving the
        // previous so nested effects restore correctly). While fn runs, getters link
        // it to their producer and onCleanup() pushes onto `cleanups`; endTrack prunes
        // only the dependencies this run stopped reading.
        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(subscriber);

        const previousCleanups = currentCleanups;
        setCurrentCleanups(cleanups);

        beginTrack(subscriber);
        running = true;

        // Errors route to the handler captured at creation; with none, the throw-time
        // uncaught handler is consulted before propagating (see catch-error.ts).
        try
        {
            // Run the body; its reads ARE the subscription (auto-tracking). A returned function is
            // registered as a cleanup, run before the next re-run and on dispose. The typeof guard
            // (not truthiness) matters: a concise arrow like `() => list.push(x)` returns a truthy
            // number, and pushing THAT would crash the next run's cleanup pass ("c is not a function")
            // far from the cause. Non-function returns are ignored, exactly as `void` promises.
            const returned: unknown = fn();

            if (typeof returned === 'function')
            {
                cleanups.push(returned as CleanupFn);
            }
        }
        catch (err)
        {
            if (subscriber.errorHandler)
            {
                subscriber.errorHandler(err);
            }
            else if (uncaughtErrorHandler)
            {
                uncaughtErrorHandler(err, { source: 'effect', name: subscriber.name });
            }
            else
            {
                throw err;
            }
        }
        finally
        {
            running = false;
            endTrack(subscriber);
            setCurrentCleanups(previousCleanups);
            setCurrentSubscriber(previousSubscriber);
            hasRun = true;
            if (devtoolsId !== 0)
            {
                dtRun(devtoolsId);
            }
        }
    }

    // Announce the effect to devtools before its first run, so the 'created' event precedes 'run'.
    devtoolsId = dtEnabled() ? dtRegister('effect', { name: options?.name, subscriber }) : 0;

    // SSR string mode: an effect has nowhere to run on the server (no DOM, no
    // client). Skip the run; it executes on the client during hydrate(). Still return
    // a disposer so call sites stay uniform.
    if (isStringMode())
    {
        registerDisposer(dispose);
        return dispose;
    }

    // If the first run throws (and no catchError handler absorbs it), the caller never
    // receives the disposer - but signals read before the throw already hold this
    // subscriber. Tear it down before rethrowing so it cannot live un-disposable.
    // (Created inside a batch, schedule() queues the first run for the flush instead.)
    try
    {
        schedule();
    }
    catch (err)
    {
        dispose();
        throw err;
    }

    // Register with the current root (if any) so it can dispose this effect.
    registerDisposer(dispose);

    // Fire cleanups, mark disposed, and unlink from all producers; idempotent. The
    // unlink is what stops a disposed effect from lingering in subscriber lists.
    function dispose(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        subscriber.isDisposed = true;

        for (const c of cleanups)
        {
            c();
        }
        cleanups = [];

        unlinkAll(subscriber);
        dtDispose(devtoolsId);
    }

    return dispose;
}
