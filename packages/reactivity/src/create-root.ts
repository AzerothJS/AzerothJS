/**
 * MODULE: reactivity/create-root
 *
 * A root is a reactive ownership scope. Every effect and memo created while a root
 * is active registers its disposer with that root, so a single dispose() tears the
 * whole group down. Roots are how the framework gives lifetimes to reactivity:
 * component boundaries dispose their subtree's effects on unmount, control-flow
 * branches (Show/For/Switch) dispose the old branch when it swaps out, and tests
 * dispose everything created during a case.
 *
 * Roots nest by saving and restoring the active root, so effects created inside an
 * inner root belong to that inner root, not the outer one.
 */

import type { DisposeFn } from './types.ts';
import { assertFunction } from './validate.ts';
import { dtRegister, dtDispose, dtEnterOwner, dtExitOwner } from './devtools.ts';

/**
 * The active root's disposer collector, or null when no root is active.
 * {@link registerDisposer} pushes here; {@link createRoot} saves/restores it.
 *
 * @internal
 */
export let currentRoot: DisposeFn[] | null = null;

/**
 * Registers a disposer with the active root, if any; with no active root the caller
 * owns disposal. Called by createEffect/createMemo at construction.
 *
 * @internal
 * @param dispose - The teardown callback to collect into the active root.
 */
export function registerDisposer(dispose: DisposeFn): void
{
    if (currentRoot !== null)
    {
        currentRoot.push(dispose);
    }
}

/**
 * createRoot
 *
 * PURPOSE:
 * Runs `fn` inside a fresh ownership scope and hands it a `dispose` callback that
 * tears down every effect and memo created during the call (and transitively, any
 * they created without their own root).
 *
 * WHY IT EXISTS:
 * Each createEffect/createMemo returns its own disposer. Tracking those by hand does
 * not scale - a component or list row may create dozens, and one missed disposer
 * leaks an effect (and everything it captures) forever. A root collects them
 * automatically so teardown is a single call, which is what makes component and
 * control-flow lifetimes tractable.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage; the lifetime primitive the renderer builds on. The
 * renderer wraps component instances and each control-flow branch in a root so that
 * unmounting (or swapping a branch) disposes exactly that subtree's reactive nodes.
 *
 * INPUT CONTRACT:
 * - fn receives the scope's `dispose`. Its return value is passed straight through.
 *   Effects/memos created synchronously inside fn are owned by this root.
 *
 * OUTPUT CONTRACT:
 * - Returns whatever fn returns. After fn completes the previous active root is
 *   restored, so creation outside the scope is unaffected.
 *
 * WHY THIS DESIGN:
 * Disposers run in reverse (stack) order so teardown mirrors construction, and the
 * collector array is cleared after disposal so dispose() is idempotent. Save/restore
 * of the active root (rather than a global) is what lets roots nest correctly.
 *
 * WHEN TO USE:
 * To bound a group of effects to a lifetime: a component, a list row, a control-flow
 * branch, or a test case.
 *
 * WHEN NOT TO USE:
 * Not for a single throwaway effect whose disposer you already hold. Do not rely on
 * the outer root to collect effects created in a detached async callback - by then
 * the active root has been restored.
 *
 * EDGE CASES:
 * - dispose() is idempotent: a second call is a no-op (the array is already cleared).
 * - Effects created in a microtask/timeout scheduled by fn are NOT owned by this
 *   root, because the active root is restored when fn returns.
 *
 * PERFORMANCE NOTES:
 * O(1) registration per child; O(n) teardown over the children at dispose. No
 * bookkeeping cost while the root is merely open.
 *
 * DEVELOPER WARNING:
 * Effects created outside any root (and not manually disposed) leak. If fn returns a
 * value you keep, remember the effects are still tied to `dispose`, not to that value.
 *
 * @typeParam T - The return type of `fn`.
 * @param fn - Receives the scope's `dispose`; its return value is passed through.
 * @returns Whatever `fn` returns.
 * @see {@link createEffect}
 * @see {@link onRootDispose}
 * @example
 * const dispose = createRoot((dispose) => {
 *     createEffect(() => console.log(count()));
 *     return dispose; // call later to tear down the effect above
 * });
 * dispose();
 */
export function createRoot<T>(fn: (dispose: DisposeFn) => T): T
{
    assertFunction(fn, 'createRoot', 'Pass the scope body as a function: createRoot((dispose) => { ... }).');

    const disposers: DisposeFn[] = [];

    const previousRoot = currentRoot;
    currentRoot = disposers;

    // Announce the root to devtools and make it the OWNER of everything created in its body, so the panel
    // can group nodes by their root. Children read the active owner at registration.
    const devtoolsId = dtRegister('root', {});
    const previousOwner = dtEnterOwner(devtoolsId);

    // Dispose in reverse (stack order); clearing the array makes it idempotent. A
    // throwing disposer must NOT strand its siblings (they would leak) nor leave the
    // array half-cleared (a second dispose() would re-run survivors): isolate each
    // call, drain fully, and surface the first error after teardown completes.
    function dispose(): void
    {
        let firstError: unknown;
        let failed = false;
        for (let i = disposers.length - 1; i >= 0; i--)
        {
            try
            {
                disposers[i]();
            }
            catch (err)
            {
                if (!failed)
                {
                    failed = true;
                    firstError = err;
                }
            }
        }
        disposers.length = 0;
        dtDispose(devtoolsId);
        if (failed)
        {
            throw firstError;
        }
    }

    try
    {
        return fn(dispose);
    }
    finally
    {
        currentRoot = previousRoot;
        dtExitOwner(previousOwner);
    }
}
