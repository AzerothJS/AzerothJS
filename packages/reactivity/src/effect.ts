// An effect is a function that re-runs whenever the signals it reads change -
// the bridge between reactive state and the outside world (DOM updates,
// logging, network requests).
//
// Lifecycle: createEffect(fn) runs fn immediately; signal getters called
// during the run link this effect to their producer (see graph.ts). When a
// subscribed signal changes the effect re-runs: any cleanups fire, then fn
// runs under a fresh tracking cursor. Dependencies are NOT torn down and
// rebuilt per run - links are kept in read order, a run that reads the same
// signals costs one compare per read, and only dependencies the run stopped
// reading are unlinked afterwards. dispose() runs the cleanups and unlinks
// everything without re-running.

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
import { registerDisposer } from './create-root.ts';
import { currentErrorHandler, uncaughtErrorHandler } from './catch-error.ts';
import { devtoolsHook, nextDevtoolsId } from './devtools-hook.ts';

// onCleanup() reads this live binding to find the running effect's cleanup
// array; the state lives in graph.ts alongside the tracking context.
export { currentCleanups } from './graph.ts';

/**
 * Creates a reactive effect that runs immediately and re-runs whenever any
 * signal it reads changes. Returns a dispose function that stops the effect
 * and unsubscribes it from every signal.
 *
 * @param fn - The effect body. May return a cleanup function that runs before
 *             each re-run and on dispose.
 * @param options - Optional configuration (name for debugging)
 *
 * @returns A dispose function that stops and cleans up the effect
 *
 * Why: reactive work has to subscribe to every signal it reads and unsubscribe
 * them all on teardown.
 *
 * Without createEffect: wire and unwire each source by hand:
 *
 *     count.subscribe(update);
 *     name.subscribe(update);
 *     // miss one unsubscribe on teardown and the closure leaks forever
 *
 * With createEffect: reads subscribe themselves, dispose() unwires them all:
 *
 *     const dispose = createEffect(() =>
 *     {
 *         render(count(), name());
 *     });
 *     dispose(); // unsubscribes from both signals in one call
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 *
 * const dispose = createEffect(() => console.log('Count:', count()));
 * // Logs "Count: 0" immediately
 *
 * setCount(5);   // Logs "Count: 5"
 * dispose();
 * setCount(10);  // Nothing logged - effect is disposed
 * ```
 *
 * @example
 * ```ts
 * // Effect with cleanup
 * createEffect(() =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);
 * });
 * ```
 */
export function createEffect(fn: EffectFn, options?: EffectOptions): DisposeFn
{
    // Cleanups for the current run, from onCleanup() calls and from fn()'s
    // return value. All run before re-execution and on dispose.
    let cleanups: CleanupFn[] = [];

    // False only for the initial run, which executes unconditionally; later
    // notifications validate dependency versions first.
    let hasRun = false;

    let debugId = 0;
    if (devtoolsHook)
    {
        debugId = nextDevtoolsId();
        devtoolsHook.created({ id: debugId, kind: 'effect', name: options?.name });
    }

    const subscriber: Subscriber =
    {
        execute: runEffect,
        isDisposed: false,
        deps: [],
        cursor: -1,
        activeRun: 0,
        // Captured once here - see types.ts on `Subscriber.errorHandler` for
        // why we don't re-read it on each run.
        errorHandler: currentErrorHandler,
        name: options?.name
    };

    function runEffect(): void
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

        // Validate before doing any work: settle memo dependencies and
        // compare versions. A notification that arrived through a memo whose
        // recompute came out equal (or a batch that coalesced back to the
        // same values) is skipped here - the body never runs, cleanups never
        // fire.
        if (hasRun && !depsChanged(subscriber))
        {
            return;
        }

        if (debugId !== 0 && devtoolsHook)
        {
            devtoolsHook.run(debugId);
        }

        // Most effects never register a cleanup; don't reallocate the array
        // on every run for them.
        if (cleanups.length > 0)
        {
            for (const c of cleanups)
            {
                c();
            }
            cleanups = [];
        }

        // Install this subscriber and cleanup array as the active context,
        // saving the previous ones so nested effects restore correctly.
        // While fn runs, signal getters link this subscriber to their
        // producer (allocation-free when the read order is unchanged), and
        // onCleanup() pushes onto `cleanups`. endTrack prunes only the
        // dependencies this run stopped reading.
        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(subscriber);

        const previousCleanups = currentCleanups;
        setCurrentCleanups(cleanups);

        beginTrack(subscriber);

        // Errors route through the handler captured when this effect was
        // created inside a `catchError` scope. With no captured handler they
        // propagate, preserving the pre-catchError contract for existing
        // call sites.
        try
        {
            const returned = fn() ?? undefined;

            if (returned)
            {
                cleanups.push(returned);
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
                // Throw-time last resort (the dev overlay); see
                // catch-error.ts for why this is not captured at creation.
                uncaughtErrorHandler(err, { source: 'effect', name: subscriber.name });
            }
            else
            {
                throw err;
            }
        }
        finally
        {
            endTrack(subscriber);
            setCurrentCleanups(previousCleanups);
            setCurrentSubscriber(previousSubscriber);
            hasRun = true;
        }
    }

    // If the first run throws (and no catchError handler absorbs it), the
    // caller never receives the disposer and the root never registers it -
    // but signals read before the throw already hold this subscriber. Tear
    // it down before rethrowing, or the half-subscribed effect lives (and
    // throws again inside some setter) forever, with no handle to stop it.
    try
    {
        runEffect();
    }
    catch (err)
    {
        dispose();
        throw err;
    }

    // Register with the current root (if any) so it can dispose this effect.
    registerDisposer(dispose);

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

        // Unlink from all producers - otherwise a disposed effect lingers
        // in their subscriber lists and leaks.
        unlinkAll(subscriber);

        if (debugId !== 0 && devtoolsHook)
        {
            devtoolsHook.disposed(debugId);
        }
    }

    return dispose;
}
