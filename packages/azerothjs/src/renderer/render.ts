/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The client mount entry point. render() owns the mount's reactive root, so a second render
 * into the same container disposes the previous tree's effects first. Mounting by hand -
 * clearing innerHTML and appending - has no scope ownership and leaks the prior mount's
 * effects on every remount.
 */

import { createRoot } from '../reactivity/index.ts';
import { destroyComponent, type MountNode } from '../component/index.ts';
import { containerDisposers } from './container-disposers.ts';
import { appendChild } from './h.ts';

/**
 * Mounts a component into `container`, clearing whatever was there and owning the new tree
 * in a reactive root.
 *
 * `component` MUST be a thunk. Passing an already-built element runs its setup outside
 * render's root, so its effects belong to nobody and leak.
 *
 * Rendering again into the same container disposes the previous mount first, so remounting
 * never accumulates effects. The container is cleared node by node rather than through
 * innerHTML, which is what lets component destroy hooks fire and a MutationObserver see the
 * removals.
 *
 * render() takes ownership of the container's content; do not mutate it from outside as
 * well.
 *
 * @param component - A thunk returning the root node, or an array of nodes for a
 *                    fragment-rooted component.
 * @param container - The element to mount into.
 * @example
 * render(() => App({}), document.getElementById('app')!);
 *
 * @see {@link hydrate} to adopt server-rendered markup instead of rebuilding it.
 */
export function render(component: () => MountNode, container: HTMLElement): void
{
    const previousDispose = containerDisposers.get(container);
    if (previousDispose)
    {
        previousDispose();
        containerDisposers.delete(container);
    }

    // Node by node, so destroy hooks run on the way out.
    while (container.firstChild)
    {
        const node = container.firstChild;
        container.removeChild(node);
        if (node instanceof HTMLElement)
        {
            destroyComponent(node);
        }
    }

    createRoot((dispose) =>
    {
        containerDisposers.set(container, dispose);
        // Through the renderer's ONE child-append routine, not a root-only reimplementation of
        // it. A fragment-rooted component returns the array form, and the compiler emits static
        // text inside it as a plain STRING - so a root loop that assumed every item was a Node
        // crashed on `<> hello <b>x</b> </>`, a shape the compiler's own diagnostic recommends.
        // appendChild already resolves arrays, getters, nodes, slot handles and primitives, and
        // is what every non-root child in the framework goes through.
        appendChild(container, component());
    });
}
