/**
 * MODULE: renderer/render
 *
 * render() mounts a component into a container element - the entry point for every
 * client-rendered AzerothJS app. It owns the mount's reactive root, so calling render()
 * again on the same container first disposes the previous tree's effects; mounting by hand
 * (container.innerHTML = ''; container.appendChild(App())) has no scope ownership and leaks
 * the prior mount's effects on every remount.
 */

import { createRoot } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { containerDisposers } from './container-disposers.ts';

/**
 * render
 *
 * PURPOSE:
 * Mounts `component`'s element into `container`, clearing any prior content and owning the
 * mount in a reactive root so it can be torn down on a later render() of the same container.
 *
 * WHY IT EXISTS:
 * An app needs one place that (1) clears the container, (2) runs the component, and (3)
 * tracks the resulting reactive scope so a remount disposes it. Doing this inline loses the
 * scope ownership and leaks effects across remounts; render() centralizes the lifecycle.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; the client mount entry point (the SSR counterpart is
 * renderToString/renderToDocument in @azerothjs/server, and {@link hydrate} adopts SSR
 * output). Establishes the top-level createRoot every component tree lives in.
 *
 * INPUT CONTRACT:
 * - component: a thunk returning the root HTMLElement (so its setup runs inside render's root).
 * - container: the host element to mount into.
 *
 * OUTPUT CONTRACT:
 * - Returns void. After it returns, the container holds exactly the new tree, and a disposer
 *   for that mount is recorded against the container.
 *
 * WHY THIS DESIGN:
 * The mount runs inside createRoot and its disposer is stored per-container, so a re-render
 * is "dispose old root, clear DOM (running destroy hooks), mount new root". Clearing node by
 * node (rather than innerHTML) lets component destroy hooks fire and a MutationObserver
 * observe removals.
 *
 * WHEN TO USE:
 * Once at startup to mount the app, or to swap the whole tree in a container.
 *
 * WHEN NOT TO USE:
 * To revive server-rendered markup - use {@link hydrate}, which adopts the existing DOM
 * instead of clearing and rebuilding it (no flash, preserves DOM state).
 *
 * EDGE CASES:
 * - Calling render() again on the same container disposes the previous mount first, so
 *   remounting never leaks.
 * - Destroy hooks run for every removed element on clear.
 *
 * PERFORMANCE NOTES:
 * One full build + append; clearing is O(children). Reactive updates afterwards are
 * fine-grained (see {@link h}), not re-renders.
 *
 * DEVELOPER WARNING:
 * `component` must be a thunk - passing an already-built element runs its setup OUTSIDE
 * render's root, leaking its effects. render() takes ownership of the container's content;
 * do not also mutate it externally.
 *
 * @param component - A thunk returning the root HTMLElement.
 * @param container - The DOM element to mount into.
 * @returns void
 * @see {@link hydrate}
 * @example
 * render(() => App({}), document.getElementById('app')!);
 */
export function render(component: () => HTMLElement, container: HTMLElement): void
{
    // Tear down the previous mount, if any.
    const previousDispose = containerDisposers.get(container);
    if (previousDispose)
    {
        previousDispose();
        containerDisposers.delete(container);
    }

    // Clear the container, running component destroy hooks on the way out.
    while (container.firstChild)
    {
        const node = container.firstChild;
        container.removeChild(node);
        if (node instanceof HTMLElement)
        {
            destroyComponent(node);
        }
    }

    // Mount inside a root so the new tree's effects can be disposed by a future render().
    createRoot((dispose) =>
    {
        containerDisposers.set(container, dispose);
        container.appendChild(component());
    });
}
