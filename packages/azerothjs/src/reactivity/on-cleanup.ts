/**
 * MODULE: reactivity/on-cleanup
 *
 * onCleanup() registers a teardown callback inside an effect. It runs before the
 * effect re-runs (on a dependency change) and when the effect is disposed. Returning
 * a cleanup from the effect body handles the single case, but an effect can return
 * only one function; onCleanup lets a run register any number of independent
 * cleanups, including conditionally - a cleanup registered only when a branch is
 * taken fires only for that branch.
 */

import type { CleanupFn } from './types.ts';
import { currentCleanups } from './graph.ts';

/**
 * onCleanup
 *
 * PURPOSE:
 * Registers a cleanup function on the currently-running effect. It runs before that
 * effect's next run and on its disposal. May be called any number of times.
 *
 * WHY IT EXISTS:
 * An effect body can return at most one cleanup, which is awkward when a run sets up
 * several resources, or sets one up only inside a conditional. onCleanup colocates
 * each teardown with its setup and scales to many, without forcing one closure to
 * remember everything.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. Reads the active effect's cleanup array (a live binding
 * from ./graph via create-effect); it is meaningful only during an effect run.
 *
 * INPUT CONTRACT:
 * - fn is the cleanup callback. Must be called synchronously within an effect run to
 *   attach to that effect.
 *
 * OUTPUT CONTRACT:
 * - Returns void. Pushes fn onto the active effect's cleanup list. Called outside any
 *   effect run it is a safe no-op (nothing is registered).
 *
 * WHY THIS DESIGN:
 * Registering against the active run's cleanup array (rather than returning a value)
 * is what enables multiple and conditional cleanups; the no-op-outside-effect rule
 * keeps call sites safe in code that may run both inside and outside a reactive scope.
 *
 * WHEN TO USE:
 * To release a resource acquired during an effect run: timers, listeners,
 * subscriptions, observers - especially when there are several or they are conditional.
 *
 * WHEN NOT TO USE:
 * Not outside an effect (it does nothing there). Not for cleanup that must run on a
 * schedule unrelated to the effect's lifecycle.
 *
 * EDGE CASES:
 * - Calling it outside an effect run is a deliberate no-op, not an error.
 * - Cleanups registered in a run fire before that effect's NEXT run, not only on final
 *   disposal, so each run starts from a clean slate.
 *
 * PERFORMANCE NOTES:
 * O(1): a single array push onto the active effect's cleanup list.
 *
 * DEVELOPER WARNING:
 * Each registered cleanup runs before every re-run, not just on dispose - make them
 * idempotent-safe and ensure they undo exactly what the run set up.
 *
 * @param fn - The cleanup function to register on the active effect.
 * @returns void
 * @see {@link createEffect}
 * @example
 * createEffect(() => {
 *     const id = setInterval(tick, 1000);
 *     onCleanup(() => clearInterval(id));
 *     if (isPolling()) {
 *         const p = setInterval(poll, 3000);
 *         onCleanup(() => clearInterval(p)); // only registered when polling
 *     }
 * });
 */
export function onCleanup(fn: CleanupFn): void
{
    if (currentCleanups !== null)
    {
        currentCleanups.push(fn);
    }
}
