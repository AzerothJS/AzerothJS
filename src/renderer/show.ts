// ============================================================================
// QUANTUM FRAMEWORK — Show (Conditional Rendering)
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
// ============================================================================

import { createEffect } from '../reactivity/effect.ts';

/**
 * Props for the Show component.
 */
export interface ShowProps
{
    /**
     * Reactive condition. When this returns true, children are shown.
     * When false, fallback is shown (or nothing).
     *
     * Must be a function (getter) so it can be reactive.
     */
    when: () => boolean;

    /**
     * Optional fallback to render when `when` returns false.
     * If not provided, nothing is rendered when condition is false.
     */
    fallback?: () => HTMLElement;
}

/**
 * Conditionally renders content based on a reactive condition.
 *
 * When the condition is true, renders the children.
 * When false, renders the fallback (or nothing).
 * Automatically swaps when the condition changes.
 *
 * @param props - ShowProps with `when` condition and optional `fallback`
 * @param children - A function that returns the content to show when true
 *
 * @returns An HTMLElement that reactively shows/hides content
 *
 * @example
 * ```ts
 * const [isLoggedIn, setIsLoggedIn] = createSignal(false);
 *
 * Show({
 *   when: isLoggedIn,
 *   fallback: () => h('p', {}, 'Please log in'),
 * }, () => h('div', {},
 *   h('p', {}, 'Welcome back!'),
 *   h('button', { onClick: logout }, 'Logout'),
 * ));
 * ```
 *
 * @example
 * ```ts
 * // Without fallback — just hides when false
 * Show({ when: showDetails }, () =>
 *   h('div', { class: 'details' },
 *     h('p', {}, () => `Email: ${email()}`),
 *     h('p', {}, () => `Phone: ${phone()}`),
 *   ),
 * );
 * ```
 */
export function Show(props: ShowProps, children: () => HTMLElement): HTMLElement
{
    // Container uses display:contents so it's invisible in the layout.
    // It doesn't create a box — its children appear as if they're
    // direct children of the container's parent.
    const container = document.createElement('span');
    container.style.display = 'contents';

    createEffect(() =>
    {
        container.innerHTML = '';

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
