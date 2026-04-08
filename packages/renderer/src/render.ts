// ============================================================================
// AZEROTHJS — render() (Mount Component to DOM)
// ============================================================================
//
// render() takes a component factory function and a container
// element, then mounts the component into the container.
//
// This is the entry point for every AzerothJS app:
//
//   render(() => App({}), document.getElementById('app')!);
//
// ============================================================================

/**
 * Mounts a component into a container DOM element.
 *
 * Clears the container and appends the component's element.
 * This is the main entry point for every AzerothJS app.
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
    // Clear the container
    while (container.firstChild)
    {
        container.removeChild(container.firstChild);
    }

    // Mount the component
    container.appendChild(component());
}
