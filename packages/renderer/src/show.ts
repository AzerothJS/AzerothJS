// ============================================================================
// AZEROTHJS — Show (Conditional Rendering)
// ============================================================================
//
// Show renders its children only when a condition is true.
// When the condition becomes false, it shows a fallback (or nothing).
//
// WITHOUT Show:
//   h('div', {},
//     () => isLoggedIn()
//       ? h('p', {}, `Welcome, ${user()}!`)
//       : h('p', {}, 'Please log in'),
//   )
//   // Works but ugly and hard to read in complex cases
//
// WITH Show:
//   Show({
//     when: isLoggedIn,
//     fallback: () => h('p', {}, 'Please log in'),
//   }, () => h('p', {}, `Welcome, ${user()}!`))
//   // Clean, readable, declarative
//
// HOW IT WORKS:
//   1. Creates a container element (display: contents — invisible wrapper)
//   2. An effect watches the `when` signal
//   3. When true → renders children into the container
//   4. When false → renders fallback (or empty) into the container
//   5. When condition changes → swaps content
//
// CLEANUP:
//
//   When swapping content, Show removes child nodes one by one
//   (not innerHTML = '') so that MutationObserver and other
//   watchers can detect removal. This is important for Portal
//   auto-cleanup.
//
// ============================================================================

import { createEffect } from '@azerothjs/reactivity';

/**
 * Props for the Show component.
 */
export interface ShowProps
{
    /**
     * Reactive condition. When true, children are shown.
     * When false, fallback is shown (or nothing).
     *
     * Must be a function (getter) so it can be reactive.
     */
    when: () => boolean;

    /**
     * Optional fallback to render when `when` returns false.
     * If not provided, nothing is rendered.
     */
    fallback?: () => HTMLElement;
}

/**
 * Conditionally renders content based on a reactive condition.
 *
 * When true, renders the children. When false, renders the
 * fallback (or nothing). Automatically swaps when the
 * condition changes.
 *
 * @param props - ShowProps with `when` condition and optional `fallback`
 * @param children - Function that returns content to show when true
 *
 * @returns An HTMLElement that reactively shows/hides content
 *
 * @example
 * ```ts
 * // With fallback
 * const [isLoggedIn, setIsLoggedIn] = createSignal(false);
 *
 * Show({
 *   when: isLoggedIn,
 *   fallback: () => h('p', {}, 'Please log in')
 * }, () => h('div', {},
 *   h('p', {}, 'Welcome back!'),
 *   h('button', { onClick: logout }, 'Logout')
 * ));
 * ```
 *
 * @example
 * ```ts
 * // Without fallback — hides when false
 * Show({ when: showDetails }, () =>
 *   h('div', { class: 'details' },
 *     h('p', {}, () => `Email: ${ email() }`)
 *   )
 * );
 * ```
 *
 * @example
 * ```ts
 * // Works with Portal — auto-cleanup when condition becomes false
 * Show(
 *   { when: isOpen },
 *   () => Portal({}, () =>
 *     h('div', { class: 'modal' }, 'I auto-clean on close!')
 *   )
 * );
 * ```
 */
export function Show(props: ShowProps, children: () => HTMLElement): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    createEffect(() =>
    {
        // Remove children properly (not innerHTML) so
        // MutationObserver can detect removals (Portal support)
        clearChildren(container);

        if (props.when())
        {
            container.appendChild(children());
        }
        else if (props.fallback)
        {
            container.appendChild(props.fallback());
        }
    });

    return container as unknown as HTMLElement;
}

/**
 * Removes all child nodes from an element one by one.
 *
 * Used instead of innerHTML = '' because removing nodes
 * individually triggers MutationObserver callbacks, which
 * is necessary for Portal auto-cleanup.
 *
 * @param el - The element to clear
 *
 * @internal
 */
function clearChildren(el: HTMLElement): void
{
    while (el.firstChild)
    {
        el.removeChild(el.firstChild);
    }
}
