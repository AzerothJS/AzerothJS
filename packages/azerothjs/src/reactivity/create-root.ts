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
import { currentCleanups, setCurrentCleanups } from './graph.ts';
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
 * Sets the active owner, returning the previous one. Effects and memos use this to
 * re-establish their CREATION owner around every run - not just the first - so a node
 * created during a re-run (a nested createRoot, a createResource, an onMount) is owned by
 * the effect that created it, and context reads resolve against the right chain, regardless
 * of whose write triggered the run.
 *
 * @internal
 */
export function setCurrentOwner(owner: Owner | null): Owner | null
{
    const previous = currentOwner;
    currentOwner = owner;
    return previous;
}

/**
 * Runs and clears an owner's disposers WITHOUT retiring the owner.
 *
 * This is the per-re-run teardown for a computation: an effect owns whatever its last run created
 * (a nested effect, an onMount, a createResource), and that work must die before the next run
 * builds its replacement. `dispose()` cannot be reused for it - that sets `disposed` permanently
 * and frees `context`, after which {@link registerDisposer} would eagerly tear down everything the
 * NEXT run creates, so a nested effect would die immediately after its first run.
 *
 * Same drain discipline as `dispose`: a pop loop (so a disposer that registers a disposer still
 * runs), each call isolated (so a throwing disposer cannot strand its siblings), first error
 * rethrown after the drain completes. Runs with the owner active so work spawned by a disposer
 * registers here rather than leaking.
 *
 * @internal
 * @param owner - The scope whose collected teardown callbacks should run now.
 */
export function drainOwner(owner: Owner): void
{
    const disposers = owner.disposers;
    if (disposers.length === 0)
    {
        return;
    }

    const previousOwner = currentOwner;
    currentOwner = owner;

    let firstError: unknown;
    let failed = false;
    try
    {
        while (disposers.length > 0)
        {
            const disposer = disposers.pop();
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
    }
    finally
    {
        currentOwner = previousOwner;
    }
    if (failed)
    {
        throw firstError;
    }
}

/**
 * Runs a compiled component's body in an ownership scope of its own.
 *
 * A component is emitted as a plain function call, so without this it has no scope: work it creates
 * belongs to whatever owner happens to be active, and a `provideContext` in its body is visible to
 * every LATER SIBLING in that scope - a value meant for one component's subtree leaking sideways
 * into the next one.
 *
 * Unlike {@link createRoot} this scope is ATTACHED: it registers with the owner that rendered it,
 * so the component's effects, memos and context die when its parent does - a `<For>` row, a `<Show>`
 * branch, an enclosing component, or the effect whose re-run built it. Nobody has to hold a
 * disposer, because a component invocation has no call site that could.
 *
 * Descendants are unaffected: they run while this owner is active, so their context reads walk up
 * through it and resolve the provided value exactly as before.
 *
 * @internal Emitted by the compiler; part of the runtime contract.
 * @typeParam T - The component body's return type (its rendered output).
 * @param fn - The component body.
 * @returns Whatever the body returns.
 */
export function componentScope<T>(fn: () => T): T
{
    const owner: Owner = { disposers: [], parent: currentOwner, context: null, errorHandler: currentErrorHandler, disposed: false };

    // Attach BEFORE switching, so this registers with the PARENT. Idempotent: the parent may drain
    // it (a re-run) and something may dispose it again, and a second pass must be a no-op rather
    // than re-running teardown that already happened.
    registerDisposer(() =>
    {
        if (owner.disposed)
        {
            return;
        }
        owner.disposed = true;
        drainOwner(owner);
        owner.context = null;
    });

    const previousOwner = currentOwner;
    const previousCleanups = currentCleanups;
    currentOwner = owner;
    // Same reasoning as createRoot: an `onCleanup` in a component body means "when this component
    // goes away", not "before the next run of whatever effect happened to render me".
    setCurrentCleanups(null);
    try
    {
        return fn();
    }
    finally
    {
        currentOwner = previousOwner;
        setCurrentCleanups(previousCleanups);
    }
}

/**
 * Registers a disposer with the active owner, if any; with no active owner the caller
 * owns disposal. Called by createEffect/createMemo at construction.
 *
 * If the active owner is ALREADY disposed - the classic `runWithOwner(getOwner(), ...)`
 * whose captured owner tore down during the await, or a node created by a disposer during
 * that owner's own teardown - the disposer is run IMMEDIATELY instead of pushed. Pushing it
 * into a drained array would leak the node: nothing disposes that array again, so the effect
 * would run forever. Tearing down now keeps the just-created node from lingering.
 *
 * @internal
 * @param dispose - The teardown callback to collect into the active root.
 */
export function registerDisposer(dispose: DisposeFn): void
{
    if (currentOwner === null)
    {
        return;
    }
    if (currentOwner.disposed)
    {
        dispose();
        return;
    }
    currentOwner.disposers.push(dispose);
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

    // A root is an ownership boundary, so `onCleanup` in its body must mean "when THIS root
    // disposes". Without clearing the ambient cleanup array, a createRoot opened from inside an
    // effect run (which is how every control-flow row and reactive hole is built) would leave the
    // effect's array installed, and the root body's onCleanup would fire on that effect's next
    // re-run instead. Deliberately NOT touching currentSubscriber: a root is not a tracking
    // boundary, and h.ts's per-run roots must keep tracking into the driving effect.
    const previousCleanups = currentCleanups;
    setCurrentCleanups(null);

    // Announce the root to devtools and make it the OWNER of everything created in its body, so the panel
    // can group nodes by their root. Children read the active owner at registration.
    const devtoolsId = dtEnabled() ? dtRegister('root', {}) : 0;
    const previousOwner = dtEnterOwner(devtoolsId);

    // Dispose in reverse (stack order). A throwing disposer must NOT strand its siblings
    // (they would leak): isolate each call, drain fully, and surface the first error after
    // teardown completes. `disposed` is set FIRST so a node created DURING teardown (a
    // disposer that builds reactive work) sees a dead owner and tears itself down at once
    // (registerDisposer) instead of registering into the array being drained. The drain is a
    // pop loop, not a fixed countdown, so any disposer a disposer does register still runs -
    // a bounded-length reverse scan would silently drop those. Idempotent via the guard.
    function dispose(): void
    {
        if (owner.disposed)
        {
            return;
        }
        owner.disposed = true;

        // Run disposers UNDER this (now-dead) owner so any reactive work a disposer spawns -
        // `onRootDispose(() => createEffect(...))` and the like - registers here and is torn
        // down at once by registerDisposer's disposed-owner path, instead of leaking as an
        // unowned node. Restored in finally so teardown never bleeds the owner into the caller.
        const previousOwner = currentOwner;
        currentOwner = owner;

        let firstError: unknown;
        let failed = false;
        try
        {
            while (disposers.length > 0)
            {
                const disposer = disposers.pop();
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
        }
        finally
        {
            currentOwner = previousOwner;
        }
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
        setCurrentCleanups(previousCleanups);
        dtExitOwner(previousOwner);
    }
}
