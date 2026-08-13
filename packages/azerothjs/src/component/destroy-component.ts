/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Tears down a rendered subtree, running any teardown hooks attached to its
 * elements. The renderer's control-flow components (Show, For, Switch, Portal, Transition,
 * ErrorBoundary, and the router's Routes) call it on the nodes they remove on a swap/unmount.
 * Hooks are attached to an element via setDestroyHooks (./destroy-hooks); reactive effects/memos
 * are torn down by their owning createRoot, so this is the place for NON-reactive cleanup that
 * rides on a DOM node.
 */

import { getDestroyHooks, setDestroyHooks, hasAnyDestroyHooks } from './destroy-hooks.ts';

/**
 * Runs and drains every teardown hook attached to `element` and its descendants.
 *
 * This is NON-reactive cleanup only. Effects and memos are disposed by their owning root;
 * what belongs here is teardown bound to a DOM node rather than a scope - a third-party
 * widget mounted on an element, an observer, a manually added listener.
 *
 * Hooks run in attachment order and are drained afterwards, so a second call on the same
 * subtree is a no-op rather than an error. Mutating the subtree from inside a hook is
 * supported: each element's children are snapshotted before the walk recurses, because a hook
 * that tears down a portal would otherwise shift a live collection mid-iteration and skip
 * siblings.
 *
 * The built-in removers already call it; reach for it directly only when removing a subtree
 * outside those paths.
 *
 * @param element - The root of the subtree. An element with no hooks is fine.
 * @see {@link createRoot} for reactive teardown.
 */
export function destroyComponent(element: HTMLElement): void
{
    // No element anywhere holds an undrained hook: the walk cannot find
    // anything, so skip it entirely. This turns the common teardown path
    // (removing hook-free rows/branches) into a constant-time no-op.
    if (!hasAnyDestroyHooks())
    {
        return;
    }

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
