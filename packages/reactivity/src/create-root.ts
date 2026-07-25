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
import { currentErrorHandler, setCurrentErrorHandler } from './catch-error.ts';
import { dtRegister, dtDispose, dtEnterOwner, dtExitOwner, dtEnabled } from './devtools.ts';

/**
 * A reactive ownership scope: the node behind every {@link createRoot}. Owners form a
 * TREE (each root records the owner it was created under), carry the scope's disposers,
 * lazily hold provided context values, and remember the error handler that was ambient
 * at creation - which is what lets {@link runWithOwner} continue work in an async
 * callback under the original scope's ownership, context, and error routing.
 *
 * Treat the object as OPAQUE: hold it, pass it to runWithOwner, nothing else. The
 * fields are the framework's bookkeeping, not API.
 */
export interface Owner
{
    /** @internal The scope's collected teardown callbacks (LIFO on dispose). */
    disposers: DisposeFn[];

    /** @internal The owner this root was created under (the ownership tree edge). */
    parent: Owner | null;

    /** @internal Context values provided AT this owner; null until first provide. */
    context: Map<symbol, unknown> | null;

    /** @internal The error handler ambient at creation; restored by runWithOwner. */
    errorHandler: ((error: unknown) => void) | null;

    /** @internal True once dispose() ran; deferred work (onMount) checks it and stands down. */
    disposed: boolean;
}

/**
 * The active owner, or null outside any root.
 * {@link registerDisposer} pushes into it; {@link createRoot} saves/restores it.
 *
 * @internal
 */
export let currentOwner: Owner | null = null;

/**
 * Registers a disposer with the active owner, if any; with no active owner the caller
 * owns disposal. Called by createEffect/createMemo at construction.
 *
 * @internal
 * @param dispose - The teardown callback to collect into the active root.
 */
export function registerDisposer(dispose: DisposeFn): void
{
    if (currentOwner !== null)
    {
        currentOwner.disposers.push(dispose);
    }
}

/**
 * The active ownership scope, or null when none is open. Capture it before starting
 * async work, then continue under it with {@link runWithOwner} - anything created in a
 * plain async callback is otherwise UNOWNED (the active owner was restored when the
 * synchronous scope returned) and leaks.
 *
 * @returns The active {@link Owner}, or null.
 * @see {@link runWithOwner}
 * @example
 * const owner = getOwner();
 * const data = await load();
 * runWithOwner(owner, () => createEffect(() => render(data, filter())));
 */
export function getOwner(): Owner | null
{
    return currentOwner;
}

/**
 * Runs `fn` under `owner`: effects/memos it creates register with that owner's
 * disposers, {@link useContext} reads that owner's context chain, and errors route to
 * the handler that was ambient when the owner was created. This is the async
 * continuation primitive - capture with {@link getOwner} before the await, resume
 * under it after. Passing null runs fn explicitly unowned.
 *
 * @typeParam T - fn's return type.
 * @param owner - The scope to run under (from {@link getOwner}), or null for unowned.
 * @param fn - The work to run under the scope.
 * @returns fn's return value.
 * @see {@link getOwner}
 */
export function runWithOwner<T>(owner: Owner | null, fn: () => T): T
{
    assertFunction(fn, 'runWithOwner', 'Pass the work as a function: runWithOwner(owner, () => { ... }).');

    const previousOwner = currentOwner;
    const previousHandler = currentErrorHandler;
    currentOwner = owner;
    setCurrentErrorHandler(owner === null ? null : owner.errorHandler);
    try
    {
        return fn();
    }
    finally
    {
        currentOwner = previousOwner;
        setCurrentErrorHandler(previousHandler);
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

    // The scope's node in the ownership tree: parent is whatever owner is active at
    // creation, and the ambient error handler is captured so runWithOwner can restore
    // the same error routing for async continuations.
    const owner: Owner = { disposers: [], parent: currentOwner, context: null, errorHandler: currentErrorHandler, disposed: false };
    const disposers = owner.disposers;

    const previousRoot = currentOwner;
    currentOwner = owner;

    // Announce the root to devtools and make it the OWNER of everything created in its body, so the panel
    // can group nodes by their root. Children read the active owner at registration.
    const devtoolsId = dtEnabled() ? dtRegister('root', {}) : 0;
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
            const disposer = disposers[i];
            if (disposer === undefined)
            {
                continue;
            }
            try
            {
                disposer();
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
        owner.disposed = true;
        // Free provided context values with the scope (the owner object itself may be
        // retained by a captured getOwner() handle; its payload must not be).
        owner.context = null;
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
        currentOwner = previousRoot;
        dtExitOwner(previousOwner);
    }
}
