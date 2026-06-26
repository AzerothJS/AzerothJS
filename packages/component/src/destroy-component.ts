/**
 * MODULE: component/destroy-component
 *
 * destroyComponent() tears down a rendered subtree, running any teardown hooks attached to its
 * elements. The renderer's control-flow components (Show, For, Switch, Portal, Transition,
 * ErrorBoundary, and the router's Routes) call it on the nodes they remove on a swap/unmount.
 * Hooks are attached to an element via setDestroyHooks (./destroy-hooks); reactive effects/memos
 * are torn down by their owning createRoot, so this is the place for NON-reactive cleanup that
 * rides on a DOM node.
 */

import { getDestroyHooks, setDestroyHooks } from './destroy-hooks.ts';

/**
 * destroyComponent
 *
 * PURPOSE:
 * Tears down a rendered subtree: runs and drains every teardown hook attached to `element` and
 * its descendants.
 *
 * WHY IT EXISTS:
 * Effects and memos are owned by their createRoot, but some teardown is bound to a DOM node, not
 * a reactive scope (a third-party widget mounted on an element, an observer, a manual listener).
 * When a control-flow component removes a node, that node-bound cleanup must still run.
 * destroyComponent is the single walk that fires it.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, component; the node-teardown primitive the renderer's removers call. It complements
 * createRoot disposal (reactive teardown), covering the non-reactive, element-attached hooks.
 *
 * INPUT CONTRACT:
 * - element: the root of the subtree to tear down. Elements with no hooks are fine (no-op).
 *
 * OUTPUT CONTRACT:
 * - Returns void. Hooks on `element` and every descendant element run once and are drained, so a
 *   second call on the same subtree is a no-op (idempotent).
 *
 * WHY THIS DESIGN:
 * Each element stores its OWN hooks, so a single top-level call walks the whole subtree -
 * control-flow components call it on the subtree root, not per element. The child list is
 * snapshotted before recursing because a hook may mutate the DOM (e.g. tear down a portal),
 * which would shift a live HTMLCollection mid-iteration and skip siblings.
 *
 * WHEN TO USE:
 * When removing a rendered subtree outside the normal control-flow paths and you need its
 * node-bound destroy hooks to fire (the built-in removers already call it).
 *
 * WHEN NOT TO USE:
 * For reactive cleanup - that is the job of createRoot/onCleanup/onRootDispose. Calling it does
 * not dispose effects (their roots do).
 *
 * EDGE CASES:
 * - Idempotent: hooks are drained after the first run, so re-destroying is safe.
 * - An element with no hooks (the common case) costs only the subtree walk.
 *
 * PERFORMANCE NOTES:
 * O(subtree size); one snapshot copy of each element's children to stay stable against in-hook
 * DOM mutation.
 *
 * DEVELOPER WARNING:
 * Hooks run in attachment order and are drained - do not rely on them firing twice. Mutating the
 * subtree from within a hook is supported (children are snapshotted), but re-entrant destroy of
 * the same node is a no-op, not an error.
 *
 * @param element - The root DOM element of the subtree to tear down.
 * @returns void
 * @see {@link createRoot}
 */
export function destroyComponent(element: HTMLElement): void
{
    runOwnDestroyHooks(element);

    // Snapshot the child list before recursing: a teardown hook may mutate the DOM (e.g. tear
    // down a portal), which would shift a live HTMLCollection mid-iteration and skip siblings. A
    // copy is stable, and re-destroying an already-handled node is a no-op (hooks are drained).
    const children = Array.from(element.children);
    for (const child of children)
    {
        if (child instanceof HTMLElement)
        {
            destroyComponent(child);
        }
    }
}

/**
 * Runs and drains the teardown hooks attached directly to one element. Drains in place (read
 * once, overwrite with []) so a second call is a no-op.
 *
 * @internal
 * @param element - The element whose own hooks to run.
 */
function runOwnDestroyHooks(element: HTMLElement): void
{
    const hooks = getDestroyHooks(element);
    if (hooks && hooks.length > 0)
    {
        setDestroyHooks(element, []);
        for (const hook of hooks)
        {
            hook();
        }
    }
}
