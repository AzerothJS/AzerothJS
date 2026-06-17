// createRoot() establishes a reactive ownership scope.
//
// Why: createEffect() returns its own disposer. Tracking one disposer per
// effect by hand doesn't scale - a component or list row may create many. A
// root collects every effect/memo created inside it so a single dispose()
// tears them all down.
//
// Use cases:
//   - Component boundaries: dispose a subtree's effects on unmount.
//   - Control-flow branches (Show/For/Switch): dispose the old branch when it
//     swaps out.
//   - Tests: dispose everything created during a case.
//
// How it works: while a root is active it's the registration target; each
// createEffect() pushes its disposer onto it (see registerDisposer). Roots
// nest by saving and restoring the active root, so effects created inside an
// inner root belong to that inner root, not the outer one.

import type { DisposeFn, DevtoolsInfo } from './types.ts';
import {
    devtoolsHook,
    nextDevtoolsId,
    currentOwnerId,
    setCurrentOwnerId,
    registerDevtoolsNode,
    unregisterDevtoolsNode
} from './devtools-hook.ts';

/**
 * The active root's disposer collector, or null when no root is active.
 * createEffect pushes its disposer here.
 *
 * @internal
 */
export let currentRoot: DisposeFn[] | null = null;

/**
 * Registers a disposer with the active root, if any. With no active root the
 * caller is responsible for disposal.
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
 * Runs `fn` in a new ownership scope, passing it a `dispose` that tears down
 * every effect/memo created inside. Nested roots own only their own effects.
 *
 * @param fn - Receives the scope's `dispose` callback; its return value is passed through
 * @returns Whatever `fn` returns
 *
 * Why: each createEffect returns its own disposer, so tearing down a group of
 * effects means tracking every one of those disposers by hand.
 *
 * Without createRoot: collect and invoke each disposer yourself:
 *
 *     const disposers = [];
 *     disposers.push(createEffect(() => render(a())));
 *     disposers.push(createEffect(() => render(b())));
 *     for (const d of disposers) d(); // miss one and that effect leaks
 *
 * With createRoot: one dispose tears down everything created inside:
 *
 *     createRoot((dispose) =>
 *     {
 *         createEffect(() => render(a()));
 *         createEffect(() => render(b()));
 *         button.onclick = dispose; // disposes both effects at once
 *     });
 *
 * @example
 * ```ts
 * createRoot((dispose) =>
 * {
 *     createEffect(() => console.log(a()));
 *     button.onclick = dispose; // disposes the effect above
 * });
 * ```
 */
export function createRoot<T>(fn: (dispose: DisposeFn) => T): T
{
    const disposers: DisposeFn[] = [];

    const previousRoot = currentRoot;
    currentRoot = disposers;

    // Devtools (off in production): give the root an id so nodes created
    // inside it record this as their owner, and surface the root itself so
    // the ownership tree has branch nodes. The registry holds the disposers
    // array weakly via its `dv`, so tracking never keeps the root alive.
    let rootId = 0;
    let rootDisposed = false;
    const previousOwner = currentOwnerId;
    if (devtoolsHook)
    {
        rootId = nextDevtoolsId();
        const dv: DevtoolsInfo = { id: rootId, kind: 'root', owner: currentOwnerId };
        (disposers as { dv?: DevtoolsInfo }).dv = dv;
        devtoolsHook.created({ id: rootId, kind: 'root', owner: currentOwnerId });
        registerDevtoolsNode(rootId, disposers);
        setCurrentOwnerId(rootId);
    }

    // Dispose in reverse (stack order); clearing the array makes it idempotent.
    function dispose(): void
    {
        for (let i = disposers.length - 1; i >= 0; i--)
        {
            disposers[i]();
        }
        disposers.length = 0;

        if (rootId !== 0 && devtoolsHook && !rootDisposed)
        {
            rootDisposed = true;
            unregisterDevtoolsNode(rootId);
            devtoolsHook.disposed(rootId);
        }
    }

    try
    {
        return fn(dispose);
    }
    finally
    {
        currentRoot = previousRoot;
        if (rootId !== 0)
        {
            setCurrentOwnerId(previousOwner);
        }
    }
}
