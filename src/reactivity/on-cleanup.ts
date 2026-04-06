// ============================================================================
// QUANTUM FRAMEWORK — onCleanup (Imperative Effect Cleanup)
// ============================================================================
//
// onCleanup() registers a cleanup function inside an effect.
// It runs before the effect re-runs and when the effect is disposed.
//
// WHY NOT JUST RETURN A CLEANUP FUNCTION?
//
//   Returning a cleanup from an effect works fine for ONE cleanup:
//
//     createEffect(() =>
//     {
//         const id = setInterval(() => tick(), 1000);
//         return () => clearInterval(id);  // single cleanup
//     });
//
//   But what if you need MULTIPLE cleanups?
//
//     createEffect(() =>
//     {
//         const id1 = setInterval(() => tick(), 1000);
//         const id2 = setTimeout(() => expire(), 5000);
//         window.addEventListener('resize', onResize);
//
//         // Can only return ONE cleanup!
//         // return () => { clearInterval(id1); clearTimeout(id2); window.removeEventListener(...) };
//
//         // With onCleanup — register each independently:
//         onCleanup(() => clearInterval(id1));
//         onCleanup(() => clearTimeout(id2));
//         onCleanup(() => window.removeEventListener('resize', onResize));
//     });
//
//   onCleanup also works in CONDITIONAL blocks:
//
//     createEffect(() =>
//     {
//         if (isActive())
//         {
//             const id = setInterval(() => poll(), 1000);
//             onCleanup(() => clearInterval(id));  // only if active
//         }
//     });
//
// ============================================================================

import type { CleanupFn } from './types.ts';
import { currentCleanups } from './effect.ts';

/**
 * Registers a cleanup function inside an effect.
 *
 * The cleanup runs:
 *   - Before the effect re-runs (when dependencies change)
 *   - When the effect is disposed
 *
 * Can be called multiple times inside a single effect to
 * register multiple independent cleanups.
 *
 * Must be called inside a createEffect() callback. Calling
 * it outside an effect does nothing (safe no-op).
 *
 * @param fn - The cleanup function to register
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
 * // Conditional cleanup
 * createEffect(() =>
 * {
 *     if (isPolling())
 *     {
 *         const id = setInterval(() => fetchData(), 3000);
 *         onCleanup(() => clearInterval(id));
 *     }
 * });
 * ```
 *
 * @example
 * ```ts
 * // Works alongside return cleanup
 * createEffect(() =>
 * {
 *     const id = setInterval(() => tick(), 1000);
 *     onCleanup(() => clearInterval(id));
 *
 *     const ws = new WebSocket(url());
 *     onCleanup(() => ws.close());
 *
 *     return () => console.log('effect re-running');
 * });
 * ```
 *
 * @example
 * ```ts
 * // Safe to call outside effects (no-op)
 * onCleanup(() => console.log('nothing happens'));
 * ```
 */
export function onCleanup(fn: CleanupFn): void
{
    if (currentCleanups !== null)
    {
        currentCleanups.push(fn);
    }
}
