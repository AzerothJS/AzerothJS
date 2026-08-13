/**
 * The bridge between reactive state and the outside world: DOM writes, logging, network,
 * subscriptions.
 *
 * Dependencies are not torn down and rebuilt each run. A run that reads the same sources
 * in the same order touches no links at all, one compare per read, and only the links the
 * run stopped reading are pruned afterwards, which keeps steady-state re-runs
 * allocation-free.
 *
 * Outside a batch an effect runs synchronously on change; inside one it is queued and
 * flushed once. Before any re-run it validates dependency versions, so a notification that
 * arrived through a memo whose recompute came out equal - or a batch that netted back to
 * the same values - is skipped entirely: the body does not run and cleanups do not fire.
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
import { currentOwner, registerDisposer, setCurrentOwner, drainOwner } from './create-root.ts';
import type { Owner } from './create-root.ts';
import { DEV } from './dev.ts';
import { currentErrorHandler, setCurrentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { assertFunction } from './validate.ts';
import { dtRegister, dtRun, dtDispose, dtEnabled } from './devtools.ts';

/**
 * Cap on consecutive self-triggered re-runs before a feedback loop is declared. Convergent
 * self-writes (ErrorBoundary catch -> setState -> fallback) settle in one or two rounds, so
 * this bound only trips on a genuine cycle.
 */
const MAX_SELF_RERUNS = 1000;

/**
 * Routes an error that escaped through an async seam - a rejected effect-body promise, a
 * throwing subscriber during a resource or stream settle - down the same ladder a
 * synchronous effect error takes: the handler captured at construction, then the global
 * uncaught handler, then a rethrow.
 *
 * The rethrow is deferred to a microtask so it surfaces as a genuine uncaught error the
 * host reports at top level, rather than an unhandled rejection nothing downstream can
 * observe - which on Node terminates the process from inside a promise reaction the
 * application never sees.
 *
 * @internal Shared by createEffect, createResource and createStream.
 */
export function routeAsyncError(
    error: unknown,
    handler: ((error: unknown) => void) | null,
    name: string | undefined
): void
{
    if (handler)
    {
        handler(error);
        return;
    }
    if (uncaughtErrorHandler)
    {
        uncaughtErrorHandler(error, { source: 'effect', name });
        return;
    }
    queueMicrotask(() =>
    {
        throw error;
    });
}

/** Structural thenable check, the same duck-typing `await` itself applies. */
function isThenable(value: unknown): value is PromiseLike<unknown>
{
    return value !== null
        && typeof value === 'object'
        && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Runs `fn` immediately, subscribes it to every reactive source it reads, and re-runs it
 * whenever one of them changes. The read is the subscription, so there is nothing to
 * unsubscribe by hand: disposal detaches the effect from every source at once.
 *
 * `fn` may return a cleanup function, which runs before EVERY re-run as well as on
 * disposal - so a cleanup must undo exactly what its own run set up. A return value that
 * is not a function is ignored, which keeps a concise arrow like `() => list.push(x)` from
 * being registered as a cleanup and crashing the next run.
 *
 * The effect owns a scope. Anything created during a run - a nested effect, memo, resource
 * or onMount - is disposed before the next run, so nested work cannot accumulate. An
 * effect created with no enclosing scope has nothing to dispose it and warns in
 * development; keep the returned disposer and call it yourself.
 *
 * Only synchronous reads are tracked. An `async` body is accepted and its rejection is
 * routed to the enclosing error handler rather than escaping as an unhandled rejection,
 * but reads after the first `await` are invisible to the graph and an async body cannot
 * register a cleanup. Use createResource for async data.
 *
 * In SSR string mode the body does not run at all - there is no DOM on the server - and a
 * disposer is returned immediately. The effect runs on the client during hydration.
 *
 * @param fn - The effect body. May return a {@link CleanupFn}.
 * @param options - Optional settings.
 * @param options.name - Debug name used in devtools and error messages.
 * @returns A disposer that runs pending cleanups, stops the effect and unsubscribes it
 *          from every source. Idempotent.
 * @throws {TypeError} If `fn` is not a function.
 * @throws {Error} If the effect keeps writing a signal it reads and fails to settle within
 *                 1000 rounds. Break the cycle with untrack, a memo, or a guarded write.
 * @throws Whatever the first run throws, when no error handler is installed. The effect is
 *         disposed before the error propagates, so a half-subscribed effect never lingers.
 * @example
 * const [count, setCount] = createSignal(0);
 *
 * const dispose = createEffect(() => console.log('Count:', count()));
 * // logs "Count: 0" immediately
 * setCount(5);  // logs "Count: 5"
 * dispose();
 * setCount(10); // nothing: disposed
 *
 * @example
 * // A cleanup runs before each re-run and on dispose.
 * createEffect(() =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);
 * });
 *
 * @see {@link createMemo} for derived values, which do not re-run their readers.
 * @see {@link onCleanup} to register several cleanups from one run.
 * @see {@link untrack} to read without subscribing.
 */
export function createEffect(fn: EffectFn, options?: EffectOptions): DisposeFn
{
    assertFunction(fn, 'createEffect', 'Pass the effect body as a function: createEffect(() => { ... }).');

    let cleanups: CleanupFn[] = [];

    // False only for the initial (unconditional) run; later runs validate versions first.
    let hasRun = false;

    // A re-trigger arriving WHILE the body is on the stack must not re-enter synchronously,
    // which would corrupt this run's tracking cursor. Record it and re-run after the body
    // unwinds. A convergent self-write settles in a round or two; a divergent one
    // (`setX(x() + 1)`) never does and is caught by the round cap below.
    let running = false;
    let rerunPending = false;

    let devtoolsId = 0;

    // This effect's own scope, allocated once and re-established around every run. Work created
    // during a run registers here and dies with the run that made it, because runOnce drains the
    // node before each re-run. Capturing the ambient owner instead made a nested computation a
    // SIBLING of this effect rather than its child, so it outlived every re-run and accumulated
    // without bound.
    //
    // One node, not one per run: getOwner() inside an effect must return the same object across
    // re-runs, and a nested createRoot holds this as its parent for the effect's whole life - a
    // per-run node would leave surviving rows resolving context through a retired owner.
    const owner: Owner = {
        disposers: [],
        parent: currentOwner,
        context: null,
        errorHandler: currentErrorHandler,
        disposed: false
    };

    if (DEV && currentOwner === null)
    {
        console.warn('azeroth: createEffect() called with no owner - nothing can dispose it, so it '
            + 'will run for the lifetime of the process. Wrap it in createRoot(), or keep the '
            + 'returned disposer and call it yourself.');
    }

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

    // What a change notification triggers. Outside a batch the body runs immediately; inside
    // one (including DURING a flush) it is queued, so a burst of writes - or writes made by a
    // flushing effect - coalesce into one run on consistent state rather than re-entering the
    // flush synchronously.
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

        // Defer rather than re-enter: re-entry would reset this run's tracking cursor
        // mid-flight. The loop below re-runs once the current body unwinds.
        if (running)
        {
            rerunPending = true;
            return;
        }

        // Settle memo deps and compare versions before any work, so a change that netted out
        // equal - through a memo, or a coalesced batch - never reaches the body.
        if (hasRun && !depsChanged(subscriber))
        {
            return;
        }

        // Re-run while a self-write keeps re-triggering. An unbounded loop trips the cap and
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
        // Teardown of the PREVIOUS run happens in a neutral scope: no subscriber, no cleanup
        // array. A signal read inside a cleanup body would otherwise link to whichever
        // computation happened to be ambient - and a re-run triggered from inside another
        // computation's tracked run (which is exactly what error-boundary.ts does when it tears a
        // branch down) made that a foreign subscriber. The graph then woke computations that never
        // read the signal at all. Cleanups tear down; they must not subscribe.
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
            // Then the work this effect's last run OWNED - nested computations, onMount handles,
            // resources. Drained, not disposed: the node stays alive for the next run.
            drainOwner(owner);
        }
        finally
        {
            setCurrentSubscriber(teardownSubscriber);
            setCurrentCleanups(teardownCleanups);
        }

        // While fn runs, getters link this subscriber to their producer and onCleanup() pushes
        // onto `cleanups`. The previous context is saved so nested effects restore correctly.
        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(subscriber);

        const previousCleanups = currentCleanups;
        setCurrentCleanups(cleanups);

        // Re-establish the creation owner + its error handler for the duration of the run, so
        // nested nodes inherit THIS scope (not the triggering write's). Restored in finally.
        const previousOwner = setCurrentOwner(owner);
        const previousHandler = setCurrentErrorHandler(subscriber.errorHandler);

        beginTrack(subscriber);
        running = true;

        // Errors route to the handler captured at creation; with none, the throw-time uncaught
        // handler is consulted before propagating (see catch-error.ts).
        try
        {
            // A typeof guard, not truthiness: a concise arrow like `() => list.push(x)` returns a
            // truthy number, and registering THAT as a cleanup would crash the next run's cleanup
            // pass far from the cause.
            const returned: unknown = fn();

            if (typeof returned === 'function')
            {
                cleanups.push(returned as CleanupFn);
            }
            else if (isThenable(returned))
            {
                // Dropping the promise would turn a throwing `await` into an unhandled rejection
                // invisible to this effect's error handling. Route it down the same ladder the
                // synchronous catch below uses.
                void returned.then(undefined, (err: unknown) =>
                {
                    routeAsyncError(err, subscriber.errorHandler, subscriber.name);
                });
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
            setCurrentErrorHandler(previousHandler);
            setCurrentOwner(previousOwner);
            setCurrentCleanups(previousCleanups);
            setCurrentSubscriber(previousSubscriber);
            hasRun = true;
            if (devtoolsId !== 0)
            {
                dtRun(devtoolsId);
            }
        }
    }

    // Registered before the first run so the devtools 'created' event precedes 'run'.
    devtoolsId = dtEnabled() ? dtRegister('effect', { name: options?.name, subscriber }) : 0;

    // On the server an effect has nowhere to run: no DOM, no client. Skip the body but still
    // return a disposer, so call sites stay uniform. It runs on the client during hydrate().
    if (isStringMode())
    {
        registerDisposer(dispose);
        return dispose;
    }

    // If the first run throws unabsorbed, the caller never receives the disposer - yet signals
    // read before the throw already hold this subscriber. Tear it down before rethrowing so it
    // cannot live on un-disposable. Created inside a batch, schedule() queues instead.
    try
    {
        schedule();
    }
    catch (err)
    {
        dispose();
        throw err;
    }

    registerDisposer(dispose);

    // Idempotent. The unlink is what stops a disposed effect from lingering in subscriber lists.
    function dispose(): void
    {
        if (subscriber.isDisposed)
        {
            return;
        }

        subscriber.isDisposed = true;

        // Same neutral scope as the re-run teardown, and for the same reason: disposal is often
        // driven from inside another computation's tracked run.
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
            // The effect is going away for good, so its scope retires with it: `disposed` is set
            // and the context payload freed, which drainOwner deliberately does not do.
            owner.disposed = true;
            drainOwner(owner);
            owner.context = null;
        }
        finally
        {
            setCurrentSubscriber(teardownSubscriber);
            setCurrentCleanups(teardownCleanups);
        }

        unlinkAll(subscriber);
        dtDispose(devtoolsId);
    }

    return dispose;
}
