// ============================================================================
// AZEROTHJS — createRoot (Reactive Ownership Scope)
// ============================================================================
//
// createRoot() creates an isolated reactive scope that owns all
// effects and memos created inside it. When the root is disposed,
// every owned effect is disposed automatically.
//
// WHY?
//
//   Without ownership, every createEffect() returns its own
//   dispose function. If you create 10 effects, you need to
//   track 10 dispose functions. Messy and error-prone.
//
//   createRoot((dispose) =>
//   {
//       createEffect(() => console.log(a()));
//       createEffect(() => console.log(b()));
//       createEffect(() => console.log(c()));
//
//       // ONE call cleans up ALL 3 effects
//       setTimeout(() => dispose(), 5000);
//   });
//
// USE CASES:
//
//   1. Component boundaries — dispose all effects on unmount
//   2. Temporary computations — create and dispose a group
//   3. Testing — clean up after each test
//   4. Dynamic sections — dispose effects when content changes
//
// HOW IT WORKS:
//
//   1. createRoot(fn) creates a new ownership context
//   2. All createEffect() calls inside fn register their
//      dispose functions with this root
//   3. fn receives a dispose callback
//   4. Calling dispose runs ALL registered disposers
//   5. Roots can nest — inner root effects belong to inner root
//
// ============================================================================

import type { DisposeFn } from './types.ts';

/**
 * The current root's disposer collector.
 *
 * When a root is active, createEffect pushes its dispose
 * function here. Set to `null` when no root is active.
 *
 * @internal Managed by createRoot, read by createEffect
 */
export let currentRoot: DisposeFn[] | null = null;

/**
 * Registers an effect's dispose function with the current root.
 *
 * Called by createEffect() after creating the effect.
 * If no root is active, the disposal is not tracked
 * (the caller must manage it manually).
 *
 * @param dispose - The effect's dispose function
 *
 * @internal
 */
export function registerDisposer(dispose: DisposeFn): void
{
    if (currentRoot !== null)
    {
        currentRoot.push(dispose);
    }
}

/**
 * Creates an isolated reactive ownership scope.
 *
 * All effects and memos created inside the callback are owned
 * by this root. When the root is disposed (via the `dispose`
 * parameter passed to the callback), all owned effects are
 * disposed automatically.
 *
 * The callback receives a `dispose` function and can optionally
 * return a value (useful for creating reactive computations
 * that need cleanup).
 *
 * Roots can nest — effects created inside an inner root belong
 * to that inner root, not the outer one.
 *
 * @typeParam T - The return type of the callback
 *
 * @param fn - A function that creates reactive computations.
 *             Receives a `dispose` callback as its argument.
 *
 * @returns The return value of the callback
 *
 * @example
 * ```ts
 * // Basic root — dispose all effects at once
 * createRoot((dispose) =>
 * {
 *     createEffect(() => console.log('A:', a()));
 *     createEffect(() => console.log('B:', b()));
 *     createEffect(() => console.log('C:', c()));
 *
 *     // Later: one call cleans up all 3 effects
 *     button.onclick = () => dispose();
 * });
 * ```
 *
 * @example
 * ```ts
 * // Root with return value
 * const el = createRoot((dispose) =>
 * {
 *     const [count, setCount] = createSignal(0);
 *
 *     createEffect(() =>
 *     {
 *         document.title = `Count: ${ count() }`;
 *     });
 *
 *     return h('div', {},
 *       h('span', {}, () => `${ count() }`),
 *       h('button', { onClick: dispose }, 'Cleanup')
 *     );
 * });
 * ```
 *
 * @example
 * ```ts
 * // Nested roots — each manages its own effects
 * createRoot((disposeOuter) =>
 * {
 *     createEffect(() => console.log('outer:', a()));
 *
 *     createRoot((disposeInner) =>
 *     {
 *         createEffect(() => console.log('inner:', b()));
 *         // disposeInner() only cleans up the inner effect
 *     });
 *
 *     // disposeOuter() only cleans up the outer effect
 * });
 * ```
 *
 * @example
 * ```ts
 * // Testing — clean up after each test
 * let dispose: () => void;
 *
 * beforeEach(() =>
 * {
 *     createRoot((d) => { dispose = d; });
 * });
 *
 * afterEach(() => dispose());
 * ```
 */
export function createRoot<T>(fn: (dispose: DisposeFn) => T): T
{
    // Create a new disposer collection for this root
    const disposers: DisposeFn[] = [];

    // Save the previous root (supports nesting)
    const previousRoot = currentRoot;
    currentRoot = disposers;

    /**
     * Disposes all effects owned by this root.
     * Safe to call multiple times — each disposer is
     * only run once (the array is cleared after).
     */
    function dispose(): void
    {
        // Run all disposers in reverse order
        // (last created = first disposed, like a stack)
        for (let i = disposers.length - 1; i >= 0; i--)
        {
            disposers[i]();
        }
        disposers.length = 0;
    }

    try
    {
        return fn(dispose);
    }
    finally
    {
        // Restore the previous root
        currentRoot = previousRoot;
    }
}
