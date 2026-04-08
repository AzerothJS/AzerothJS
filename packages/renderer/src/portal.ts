// ============================================================================
// QUANTUM FRAMEWORK — Portal (Render Outside Parent)
// ============================================================================
//
// Portal renders children into a different part of the DOM tree,
// outside of the component's parent hierarchy.
//
//   Without Portal:
//     <div class="card" style="overflow: hidden">
//       <Modal>  ← Gets clipped! Can't escape parent's overflow.
//     </div>
//
//   With Portal:
//     <div class="card" style="overflow: hidden">
//       Portal({ target: document.body }, () => Modal({}))
//       ← Modal renders in document.body, not inside .card
//     </div>
//
// WHY?
//   Modals, tooltips, dropdowns, and toasts need to render at the
//   top level of the page (usually document.body) to avoid:
//     - overflow: hidden clipping
//     - z-index stacking context issues
//     - CSS transform breaking position: fixed
//
// CLEANUP:
//   Portal uses MutationObserver to watch its placeholder element.
//   When the placeholder is removed from the DOM (e.g., by Show
//   toggling to false), the portaled content is automatically
//   removed from the target. No manual cleanup needed.
//
//   Show(
//     { when: isOpen },
//     () => Portal({}, () => h('div', { class: 'modal' }, '...'))
//   )
//
//   OPEN:   Show renders Portal → Portal appends modal to body ✅
//   CLOSE:  Show removes placeholder → MutationObserver fires
//           → Portal removes modal from body ✅
//
// ============================================================================

import { destroyComponent } from '@quantum/component';

/**
 * Props for the Portal component.
 */
export interface PortalProps
{
    /**
     * The DOM element to render children into.
     * Defaults to document.body if not specified.
     */
    target?: HTMLElement;
}

/**
 * Renders children into a target DOM element outside the
 * component's parent hierarchy.
 *
 * Returns a placeholder element in the original tree. When
 * the placeholder is removed from the DOM (e.g., by Show),
 * the portaled content is automatically cleaned up via
 * MutationObserver.
 *
 * @param props - PortalProps with optional target element
 * @param children - Function that returns the content to portal
 *
 * @returns A hidden placeholder element in the original tree
 *
 * @example
 * ```ts
 * // Render a modal into document.body
 * Portal({}, () =>
 *   h('div', { class: 'modal-overlay' },
 *     h('div', { class: 'modal' },
 *       h('h2', {}, 'Are you sure?'),
 *       h('button', { onClick: closeModal }, 'Close')
 *     )
 *   )
 * );
 * ```
 *
 * @example
 * ```ts
 * // Render into a specific container
 * const tooltipLayer = document.getElementById('tooltip-layer')!;
 *
 * Portal({ target: tooltipLayer }, () =>
 *   h('div', { class: 'tooltip' }, 'Helpful tip!')
 * );
 * ```
 *
 * @example
 * ```ts
 * // Works with Show — auto-cleanup when condition becomes false
 * Show(
 *   { when: isOpen },
 *   () => Portal({}, () =>
 *     h('div', { class: 'modal' }, 'I auto-clean on close!')
 *   )
 * );
 * ```
 */
export function Portal(props: PortalProps, children: () => HTMLElement): HTMLElement
{
    const target = props.target ?? document.body;
    const content = children();

    // Append the content to the target (outside parent tree)
    target.appendChild(content);

    // Create an invisible placeholder in the original tree
    const placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.setAttribute('data-quantum-portal', '');

    // ── Auto-cleanup with MutationObserver ───────────────────
    //
    // Watch for the placeholder being removed from the DOM.
    // When Show() toggles to false, it clears its container
    // which removes the placeholder. We detect that and clean
    // up the portaled content automatically.
    //
    const observer = new MutationObserver((mutations) =>
    {
        for (const mutation of mutations)
        {
            for (const removed of mutation.removedNodes)
            {
                if (removed === placeholder || removed.contains(placeholder))
                {
                    cleanup();
                    return;
                }
            }
        }
    });

    // Start observing — defer until placeholder is in the DOM
    requestAnimationFrame(() =>
    {
        const root = placeholder.parentElement;
        if (root)
        {
            observer.observe(root, { childList: true, subtree: true });
        }
    });

    /**
     * Removes the portaled content from the target and
     * disconnects the MutationObserver.
     */
    function cleanup(): void
    {
        observer.disconnect();

        if (target.contains(content))
        {
            destroyComponent(content);
            target.removeChild(content);
        }
    }

    // Store cleanup function for manual use via destroyPortal()
    (placeholder as any).__quantum_portal_cleanup = cleanup;

    return placeholder;
}

/**
 * Manually removes a Portal's content from its target.
 *
 * Usually not needed — Portal auto-cleans when its placeholder
 * is removed from the DOM. But available for edge cases.
 *
 * @param placeholder - The placeholder element returned by Portal()
 *
 * @example
 * ```ts
 * const el = Portal({}, () => h('div', {}, 'Modal'));
 * // Later:
 * destroyPortal(el);  // Removes the modal from document.body
 * ```
 */
export function destroyPortal(placeholder: HTMLElement): void
{
    const cleanup = (placeholder as any).__quantum_portal_cleanup as (() => void) | undefined;

    if (cleanup)
    {
        cleanup();
    }
}
