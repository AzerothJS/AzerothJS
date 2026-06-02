// render() mounts a component factory into a container element. It is the
// entry point for every AzerothJS app:
//
//   render(() => App({}), document.getElementById('app')!);
//
// Calling render() again on the same container disposes the prior tree's
// reactive scope first, so apps can be remounted without leaking effects.
//
// Without render: clear the container and append by hand, and track the
// mount's reactive scope yourself to dispose it on a remount.
//
//     container.innerHTML = '';
//     container.appendChild(App({}));
//     // no scope ownership, so the prior mount's effects leak on every remount
//
// With render: it owns the root scope and tears down the prior mount.
//
//     render(() => App({}), container);
//     // prior mount is disposed first, so remounting never leaks effects

import { createRoot } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { containerDisposers } from './container-disposers.ts';

/**
 * Mounts a component into a container DOM element.
 *
 * Clears the container and appends the component's element. The
 * mount lives in its own root so all effects created during setup
 * can be disposed if render() is called again on the same
 * container.
 *
 * @param component - A function that returns the root HTMLElement
 * @param container - The DOM element to mount into
 *
 * @example
 * ```ts
 * const App = defineComponent(() =>
 * {
 *     return h('div', {},
 *       h('h1', {}, 'Hello AzerothJS!'),
 *     );
 * });
 *
 * render(() => App({}), document.getElementById('app')!);
 * ```
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

    // Clear the container, running component destroy hooks on the
    // way out so on-destroy callbacks fire.
    while (container.firstChild)
    {
        const node = container.firstChild;
        container.removeChild(node);
        if (node instanceof HTMLElement)
        {
            destroyComponent(node);
        }
    }

    // Mount inside a root so the new tree's effects can be disposed
    // by a future render() call.
    createRoot((dispose) =>
    {
        containerDisposers.set(container, dispose);
        container.appendChild(component());
    });
}
