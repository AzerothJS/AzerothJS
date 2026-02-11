// ============================================================================
// QUANTUM FRAMEWORK — Effect (Reactive Side Effects)
// ============================================================================
//
// An effect is a function that runs automatically when the signals it
// reads change. It is the bridge between reactive state (signals) and
// the outside world (DOM updates, logging, network requests, etc.).
//
// This file exports:
//   - createEffect() — Creates a reactive effect
//
// HOW IT WORKS:
//
//   1. createEffect(fn) is called
//   2. The effect sets itself as `currentEffect` (via setCurrentEffect)
//   3. fn() runs — any signals read inside will subscribe this effect
//   4. The effect clears `currentEffect`
//   5. Later, when a signal changes, it calls this effect (subscriber)
//   6. The effect re-runs (back to step 2)
//
// LIFECYCLE:
//
//   Created → Runs immediately → Waits for signal changes → Re-runs → ...
//                                                                     │
//   dispose() called → Cleanup runs → Effect is permanently stopped ──┘
//
// ============================================================================

import type { EffectFn, CleanupFn, Subscriber, EffectOptions } from './types.js';
import { getCurrentEffect, setCurrentEffect } from './signal.js';

/**
 * Creates a reactive effect that automatically re-runs when its
 * signal dependencies change.
 *
 * Effects are the primary way to perform side effects in response
 * to state changes: updating the DOM, logging, making API calls,
 * setting up subscriptions, etc.
 *
 * @param fn - The effect function to run reactively. Can optionally
 *             return a {@link CleanupFn} for resource teardown.
 * @param options - Optional configuration (e.g., defer initial run)
 *
 * @returns A dispose function that permanently stops the effect
 *          and runs its cleanup. Once disposed, the effect will
 *          never run again, even if its signals change.
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 *
 * // Basic effect — runs immediately, then on every change
 * const dispose = createEffect(() =>
 * {
 *     console.log('Count is:', count());
 * });
 * // Console: "Count is: 0"
 *
 * setCount(1);  // Console: "Count is: 1"
 * setCount(2);  // Console: "Count is: 2"
 *
 * dispose();    // Effect is permanently stopped
 * setCount(3);  // Nothing happens — effect is disposed
 * ```
 *
 * @example
 * ```ts
 * // Effect with cleanup
 * createEffect(() =>
 * {
 *     const id = setInterval(() => console.log(count()), 1000);
 *     return () => clearInterval(id);  // Cleanup on re-run or dispose
 * });
 * ```
 *
 * @example
 * ```ts
 * // Deferred effect — doesn't run until first signal change
 * createEffect(() =>
 * {
 *     console.log('Count changed to:', count());
 * }, { defer: true });
 * // Console: (nothing — deferred!)
 *
 * setCount(1);  // NOW it runs: "Count changed to: 1"
 * ```
 */
export function createEffect(fn: EffectFn, options?: EffectOptions): CleanupFn
{
    let cleanup: CleanupFn | void;

    let isDisposed = false;

    const effect: Subscriber = (): void =>
    {
        if (isDisposed)
        {
            return;
        }

        if (cleanup)
        {
            cleanup();
        }

        // Save the parent effect (for nested effects)
        const parentEffect = getCurrentEffect();

        // Set this effect as the current tracker
        setCurrentEffect(effect);

        try
        {
            // Run the user's function — signals inside will track this effect
            cleanup = fn();
        }
        finally
        {
            // Restore the parent effect (even if fn() throws an error)
            setCurrentEffect(parentEffect);
        }
    };

    if (!options?.defer)
    {
        effect();
    }

    return (): void =>
    {
        isDisposed = true;

        if (cleanup)
        {
            cleanup();
        }
    };
}
