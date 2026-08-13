/**
 * Ownership scopes: how reactivity gets a lifetime. Every effect and memo created while a
 * root is active registers its disposer there, so one dispose() tears the whole group down.
 * Component boundaries dispose their subtree on unmount, control-flow branches dispose the
 * outgoing branch on a swap, and a test disposes everything a case created.
 *
 * Roots nest by saving and restoring the active owner, so a node created inside an inner
 * root belongs to that root and not the outer one.
 */

import type { DisposeFn } from './types.ts';
import { assertFunction } from './validate.ts';
import { currentCleanups, setCurrentCleanups } from './graph.ts';
import { currentErrorHandler, setCurrentErrorHandler } from './catch-error.ts';
import { dtRegister, dtDispose, dtEnterOwner, dtExitOwner, dtEnabled } from './devtools.ts';

/**
 * A reactive ownership scope, the node behind every {@link createRoot}. Owners form a tree:
 * each records the owner it was created under, carries that scope's disposers, lazily holds
 * provided context values, and remembers the error handler ambient at creation - which is
 * what lets {@link runWithOwner} resume async work under the original scope's ownership,
 * context and error routing.
 *
 * Treat it as opaque: capture it with {@link getOwner}, pass it to {@link runWithOwner},
 * nothing else. The fields are framework bookkeeping, not API.
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

/** The active owner, or null outside any root. @internal */
export let currentOwner: Owner | null = null;

/**
 * Sets the active owner and returns the previous one. Effects and memos re-establish their
 * CREATION owner around every run, not just the first, so a node created during a re-run is
 * owned by the effect that created it and context resolves against the right chain no
 * matter whose write triggered the run.
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
 * Runs and clears an owner's disposers WITHOUT retiring the owner: the per-re-run teardown
 * for a computation. An effect owns whatever its last run created, and that work must die
 * before the next run builds its replacement.
 *
 * `dispose()` cannot be reused here, because it sets `disposed` permanently and frees
 * `context`, after which {@link registerDisposer} would eagerly tear down everything the
 * NEXT run creates - a nested effect would die immediately after its first run.
 *
 * Same drain discipline as dispose: a pop loop so a disposer that registers a disposer
 * still runs, each call isolated so a throwing disposer cannot strand its siblings, and the
 * first error rethrown once the drain completes. The owner stays active throughout, so work
 * a disposer spawns registers here rather than leaking.
 *
 * @internal
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
 * A component is emitted as a plain function call, so without this it has no scope: work it
 * creates belongs to whatever owner happens to be active, and a `provideContext` in its body
 * stays visible to every LATER SIBLING in that scope - a value meant for one component's
 * subtree leaking sideways into the next.
 *
 * Unlike {@link createRoot} this scope is attached. It registers with the owner that
 * rendered it, so the component's effects, memos and context die when its parent does: a
 * `<For>` row, a `<Show>` branch, an enclosing component, or the effect whose re-run built
 * it. Nobody has to hold a disposer, because a component invocation has no call site that
 * could.
 *
 * Descendants are unaffected - they run while this owner is active, so their context reads
 * walk up through it and resolve exactly as before.
 *
 * @internal Emitted by the compiler; part of the runtime contract.
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
 * Collects a disposer into the active owner. With no active owner the caller owns disposal.
 *
 * If the active owner is ALREADY disposed - a `runWithOwner(getOwner(), ...)` whose captured
 * owner tore down during the await, or a node created by a disposer during that owner's own
 * teardown - the disposer runs immediately instead of being pushed. Pushing into a drained
 * array would leak the node, since nothing drains that array again and the effect would run
 * forever.
 *
 * @internal
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
 * The active ownership scope, or null when none is open.
 *
 * Capture it BEFORE starting async work and resume under it with {@link runWithOwner}.
 * Anything created in a plain async callback is otherwise unowned and leaks, because the
 * active owner was restored the moment the synchronous scope returned.
 *
 * @returns The active {@link Owner}, or null outside every scope.
 * @example
 * const owner = getOwner();
 * const data = await load();
 * runWithOwner(owner, () => createEffect(() => render(data, filter())));
 *
 * @see {@link runWithOwner}
 */
export function getOwner(): Owner | null
{
    return currentOwner;
}

/**
 * Runs `fn` under `owner`: effects and memos it creates register with that owner's
 * disposers, context reads resolve against that owner's chain, and errors route to the
 * handler ambient when the owner was created.
 *
 * This is the async continuation primitive - capture with {@link getOwner} before the
 * await, resume under it afterwards. If the captured owner was disposed while awaiting,
 * anything created here is torn down immediately rather than leaking.
 *
 * @typeParam T - `fn`'s return type.
 * @param owner - The scope to run under, or null to run explicitly unowned.
 * @param fn - The work to run.
 * @returns Whatever `fn` returns.
 * @throws {TypeError} If `fn` is not a function.
 * @example
 * const owner = getOwner();
 *
 * setTimeout(() =>
 * {
 *     runWithOwner(owner, () =>
 *     {
 *         createEffect(() => sync(state())); // disposed with the original scope
 *     });
 * }, 1000);
 *
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
 * Runs `fn` in a fresh ownership scope and hands it the `dispose` that tears down
 * everything the call created: every effect and memo, and transitively anything they
 * created without a root of their own.
 *
 * Only work created SYNCHRONOUSLY inside `fn` is owned. The active owner is restored the
 * moment `fn` returns, so an effect created later from a timer or a promise callback
 * belongs to nobody - capture {@link getOwner} and resume through {@link runWithOwner} for
 * that case.
 *
 * Disposal runs in reverse order, so teardown mirrors construction, and is idempotent. A
 * throwing disposer does not strand its siblings: every disposer runs, and the first error
 * is rethrown once the drain completes.
 *
 * `onCleanup` called directly in the body attaches to THIS root, not to any effect that
 * happens to be running around it.
 *
 * @typeParam T - `fn`'s return type.
 * @param fn - Receives this scope's `dispose`.
 * @returns Whatever `fn` returns.
 * @throws {TypeError} If `fn` is not a function.
 * @throws The first error thrown by a disposer, rethrown after all of them have run.
 * @example
 * const dispose = createRoot((dispose) =>
 * {
 *     createEffect(() => console.log(count()));
 *     return dispose;
 * });
 *
 * dispose(); // the effect above stops; calling again is a no-op
 *
 * @see {@link createEffect}
 * @see {@link onRootDispose} to register teardown from inside the scope.
 * @see {@link runWithOwner} to keep ownership across async boundaries.
 */
export function createRoot<T>(fn: (dispose: DisposeFn) => T): T
{
    assertFunction(fn, 'createRoot', 'Pass the scope body as a function: createRoot((dispose) => { ... }).');

    // The ambient error handler is captured so runWithOwner can restore the same error
    // routing for async continuations.
    const owner: Owner = { disposers: [], parent: currentOwner, context: null, errorHandler: currentErrorHandler, disposed: false };
    const disposers = owner.disposers;

    const previousRoot = currentOwner;
    currentOwner = owner;

    // A root is an ownership boundary, so `onCleanup` in its body must mean "when THIS root
    // disposes". Without clearing the ambient cleanup array, a createRoot opened from inside an
    // effect run - which is how every control-flow row and reactive hole is built - would leave
    // the effect's array installed, and the body's onCleanup would fire on that effect's next
    // re-run instead. currentSubscriber is deliberately untouched: a root is not a tracking
    // boundary, and h.ts's per-run roots must keep tracking into the driving effect.
    const previousCleanups = currentCleanups;
    setCurrentCleanups(null);

    // Make the root the devtools owner of everything created in its body, so the panel can group
    // nodes by root. Children read the active owner at registration.
    const devtoolsId = dtEnabled() ? dtRegister('root', {}) : 0;
    const previousOwner = dtEnterOwner(devtoolsId);

    // A throwing disposer must not strand its siblings, or they leak: isolate each call, drain
    // fully, surface the first error afterwards. `disposed` is set FIRST so a node created
    // during teardown sees a dead owner and tears itself down at once (registerDisposer)
    // instead of registering into the array being drained. The drain is a pop loop rather than
    // a bounded reverse scan, so a disposer registered by a disposer still runs.
    function dispose(): void
    {
        if (owner.disposed)
        {
            return;
        }
        owner.disposed = true;

        // Run disposers under this now-dead owner, so reactive work a disposer spawns registers
        // here and is torn down at once by registerDisposer's disposed-owner path instead of
        // leaking unowned. Restored in finally so teardown never bleeds the owner into the caller.
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
