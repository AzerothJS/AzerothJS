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

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, isStringMode, isHydrating, untrack, serializeChild, wrapContents, hydrationNode, HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { hydrateChild } from './h.ts';

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

    /**
     * The content shown when `when` is true. A thunk so it's only
     * built while visible. Passed as a prop (not a positional
     * argument) so the manual API matches the compiled `.azeroth`
     * form: `<Show when={…}>…</Show>`.
     */
    children: () => HTMLElement;
}

/**
 * Conditionally renders content based on a reactive condition.
 *
 * When true, renders the children. When false, renders the
 * fallback (or nothing). Automatically swaps when the
 * condition changes.
 *
 * @param props - ShowProps with `when`, `children`, and optional `fallback`
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
 *   fallback: () => h('p', {}, 'Please log in'),
 *   children: () => h('div', {},
 *     h('p', {}, 'Welcome back!'),
 *     h('button', { onClick: logout }, 'Logout')
 *   )
 * });
 * ```
 *
 * @example
 * ```ts
 * // Without fallback — hides when false
 * Show({
 *   when: showDetails,
 *   children: () => h('div', { class: 'details' },
 *     h('p', {}, () => `Email: ${ email() }`)
 *   )
 * });
 * ```
 */
export function Show(props: ShowProps): HTMLElement
{
    // ── Server-side rendering ─────────────────────────────────
    // Evaluate `when` ONCE (no live effect), emit the active branch
    // inside a contents-wrapper anchor the client hydrator can adopt.
    if (isStringMode())
    {
        const factory = untrack(() => props.when()) ? props.children : props.fallback;
        const inner = factory ? serializeChild(factory()) : '';
        return wrapContents('show', inner) as unknown as HTMLElement;
    }

    // ── Hydration ─────────────────────────────────────────────
    // Adopt the server-rendered wrapper span and its current branch on
    // the first effect run; subsequent toggles use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            driveShow(props, cursor.takeElement('span'), true);
        }) as unknown as HTMLElement;
    }

    const container = document.createElement('span');
    container.style.display = 'contents';

    driveShow(props, container, false);

    return container as unknown as HTMLElement;
}

/**
 * Wires the reactive branch effect onto `container`. Shared by the DOM path
 * (a freshly created span) and the hydration path (the adopted server span).
 *
 * @param props - The Show props
 * @param container - The contents wrapper to render branches into
 * @param hydrateFirstRun - When true, the FIRST effect run adopts the span's
 *                          existing server children instead of appending new ones
 *
 * @internal
 */
function driveShow(props: ShowProps, container: HTMLElement, hydrateFirstRun: boolean): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    createEffect(() =>
    {
        // Render the active branch — `children` when `when` is true,
        // otherwise the optional `fallback` — inside its own root so
        // the whole subtree (effects + components) disposes as one
        // unit on the next swap.
        const factory = props.when() ? props.children : props.fallback;

        if (firstRun)
        {
            // Hydration first run: adopt the existing server children
            // rather than building and appending new ones.
            firstRun = false;
            if (factory)
            {
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(factory(), new HydrationCursor(container));
                });
            }
            return teardownBranch;
        }

        if (factory)
        {
            createRoot((d) =>
            {
                branchDispose = d;
                container.appendChild(factory());
            });
        }

        // `teardownBranch` is the SINGLE teardown path: the effect
        // runs it before every re-render AND on dispose. Without
        // this, every toggle would leak the effects created inside
        // the rendered subtree.
        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

        // Remove children one-by-one so MutationObserver can fire
        // (needed for Portal auto-cleanup), and run component
        // destroy hooks on each removed element.
        while (container.firstChild)
        {
            const node = container.firstChild;
            container.removeChild(node);
            if (node instanceof HTMLElement)
            {
                destroyComponent(node);
            }
        }
    }
}
