// onCleanup() registers a cleanup function inside an effect; it runs before
// the effect re-runs and when the effect is disposed.
//
// Returning a cleanup from the effect handles the single-cleanup case, but an
// effect can only return one function. onCleanup lets you register any number
// of independent cleanups, and works inside conditional blocks - a cleanup
// registered only when a branch is taken fires only for that branch.

import type { CleanupFn } from './types.ts';
import { currentCleanups } from './effect.ts';

/**
 * Registers a cleanup function inside an effect. It runs before the effect
 * re-runs (on a dependency change) and when the effect is disposed. Call it
 * any number of times to register independent cleanups. Calling it outside an
 * effect is a safe no-op.
 *
 * @param fn - The cleanup function to register
 *
 * Why: an effect can return only one cleanup function, which is awkward when a
 * run sets up several resources or sets one up conditionally.
 *
 * Without onCleanup: fold every teardown into a single returned closure:
 *
 *     createEffect(() =>
 *     {
 *         const id = setInterval(tick, 1000);
 *         window.addEventListener('resize', onResize);
 *         return () => // one function must remember to undo both
 *         {
 *             clearInterval(id);
 *             window.removeEventListener('resize', onResize);
 *         };
 *     });
 *
 * With onCleanup: register each teardown next to its setup:
 *
 *     createEffect(() =>
 *     {
 *         const id = setInterval(tick, 1000);
 *         onCleanup(() => clearInterval(id));
 *         window.addEventListener('resize', onResize);
 *         onCleanup(() => window.removeEventListener('resize', onResize));
 *     });
 *
 * @example
 * ```ts
 * // Multiple independent cleanups
 * createEffect(() =>
 * {
 *     const timerId = setInterval(() => tick(), 1000);
 *     onCleanup(() => clearInterval(timerId));
 *
 *     window.addEventListener('resize', handleResize);
 *     onCleanup(() => window.removeEventListener('resize', handleResize));
 * });
 * ```
 *
 * @example
 * ```ts
 * // Conditional cleanup - registered only when the branch is taken
 * createEffect(() =>
 * {
 *     if (isPolling())
 *     {
 *         const id = setInterval(() => fetchData(), 3000);
 *         onCleanup(() => clearInterval(id));
 *     }
 * });
 * ```
 */
export function onCleanup(fn: CleanupFn): void
{
    if (currentCleanups !== null)
    {
        currentCleanups.push(fn);
    }
}
