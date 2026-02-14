// ============================================================================
// QUANTUM FRAMEWORK — Render (Mount to DOM)
// ============================================================================
//
// The render function mounts an application into a DOM container.
// It takes a function that returns an HTMLElement (from h()) and
// appends it to the target container.
//
// Since h() already creates REAL DOM elements with reactive bindings
// wired up, render() is intentionally simple — it just mounts the tree.
//
// ============================================================================

/**
 * Mounts an application into a DOM container element.
 *
 * Takes a function that returns the root element of your app
 * (built with h()) and appends it to the specified container.
 *
 * Since Quantum's h() function returns real DOM elements with
 * reactive effects already wired up, render() simply clears the
 * container and appends the root element. All reactivity is
 * handled by the signals and effects inside h().
 *
 * @param app - A function that returns the root HTMLElement.
 *              Wrapped in a function to support future features
 *              like hot module replacement and re-mounting.
 * @param container - The DOM element to mount the app into.
 *                    Usually `document.getElementById('app')`.
 *
 * @example
 * ```ts
 * import { createSignal } from 'quantumjs';
 * import { h, render } from 'quantumjs';
 *
 * const [count, setCount] = createSignal(0);
 *
 * render(
 *   () => h('div', {},
 *     h('p', {}, () => `Count: ${count()}`),
 *     h('button', { onClick: () => setCount(prev => prev + 1) }, '+1'),
 *   ),
 *   document.getElementById('app')!,
 * );
 *
 * // The <p> updates automatically when button is clicked.
 * ```
 */
export function render(app: () => HTMLElement, container: HTMLElement): void
{
    container.innerHTML = '';

    const rootElement = app();

    container.appendChild(rootElement);
}
