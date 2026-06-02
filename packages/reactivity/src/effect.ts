// An effect is a function that re-runs whenever the signals it reads change -
// the bridge between reactive state and the outside world (DOM updates,
// logging, network requests).
//
// Lifecycle: createEffect(fn) runs fn immediately; signal getters called
// during the run subscribe this effect, each adding an unsubscribe closure to
// `dependencies`. When a subscribed signal changes the effect re-runs: any
// cleanups fire, every dependency is unsubscribed, and fn runs again,
// re-subscribing to whatever it reads this time. dispose() does the same
// teardown but without re-running.
//
// We re-subscribe from scratch on every run because dependencies can change
// between runs. An effect that reads details() in one branch and summary() in
// another must end up subscribed to exactly the signals it touched this time;
// clearing and rebuilding the dependency set each run guarantees that.

import type { EffectFn, DisposeFn, CleanupFn, Subscriber, EffectOptions } from './types.ts';
import { currentSubscriber, setCurrentSubscriber } from './signal.ts';
import { isBatching, queueEffect } from './batch.ts';
import { registerDisposer } from './create-root.ts';
import { currentErrorHandler } from './catch-error.ts';

/**
 * The cleanup array for the currently running effect, or `null` when no effect
 * is running. onCleanup() pushes to this during effect execution.
 *
 * @internal Managed by createEffect, read by onCleanup
 */
export let currentCleanups: CleanupFn[] | null = null;

/**
 * Creates a reactive effect that runs immediately and re-runs whenever any
 * signal it reads changes. Returns a dispose function that stops the effect
 * and unsubscribes it from every signal.
 *
 * @param fn - The effect body. May return a cleanup function that runs before
 *             each re-run and on dispose.
 * @param _options - Optional configuration (name for debugging)
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
export function createEffect(fn: EffectFn, _options?: EffectOptions): DisposeFn
{
    // Cleanups for the current run, from onCleanup() calls and from fn()'s
    // return value. All run before re-execution and on dispose.
    let cleanups: CleanupFn[] = [];

    const subscriber: Subscriber =
    {
        execute: runEffect,
        isDisposed: false,
        dependencies: new Set(),
        // Captured once here - see types.ts on `Subscriber.errorHandler` for
        // why we don't re-read it on each run.
        errorHandler: currentErrorHandler
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

        for (const c of cleanups)
        {
            c();
        }
        cleanups = [];

        // Unsubscribe from every current dependency before re-running, so a
        // run that reads different signals doesn't keep stale subscriptions.
        cleanupDependencies(subscriber);

        // Install this subscriber and cleanup array as the active context,
        // saving the previous ones so nested effects restore correctly. While
        // fn runs, signal getters add this subscriber to their subscriber set
        // (and a matching unsubscribe to subscriber.dependencies), and
        // onCleanup() pushes onto `cleanups`.
        const previousSubscriber = currentSubscriber;
        setCurrentSubscriber(subscriber);

        const previousCleanups = currentCleanups;
        currentCleanups = cleanups;

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
            else
            {
                throw err;
            }
        }
        finally
        {
            currentCleanups = previousCleanups;
            setCurrentSubscriber(previousSubscriber);
        }
    }

    runEffect();

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

        // Unsubscribe from all signals - otherwise a disposed effect lingers
        // in their subscriber sets and leaks.
        cleanupDependencies(subscriber);
    }

    return dispose;
}

/**
 * Removes a subscriber from every signal it subscribed to and clears its
 * dependency set. Each dependency closure removes the subscriber from one
 * signal's subscriber Set; running them all is what keeps disposed and
 * re-running effects from leaking.
 *
 * @param subscriber - The subscriber to clean up
 *
 * @internal
 */
function cleanupDependencies(subscriber: Subscriber): void
{
    for (const unsubscribe of subscriber.dependencies)
    {
        unsubscribe();
    }

    subscriber.dependencies.clear();
}
