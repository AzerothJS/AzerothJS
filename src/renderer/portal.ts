// ============================================================================
// QUANTUM FRAMEWORK — Portal (Render Outside Parent)
// ============================================================================
//
// Portal renders children into a different part of the DOM tree,
// outside of the component's parent hierarchy.
//
// WHY?
//   Modals, tooltips, dropdowns, and toasts need to render at the
//   top level of the page (usually document.body) to avoid:
//     - overflow: hidden clipping
//     - z-index stacking context issues
//     - CSS transform breaking position: fixed
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
// CLEANUP:
//   Portal uses MutationObserver to watch its placeholder element.
//   When the placeholder is removed from the DOM (e.g., by Show
//   toggling to false), the portaled content is automatically
//   removed from the target. No manual cleanup needed.
//
// ============================================================================

import { destroyComponent } from '../component/define-component.ts';

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
 * the placeholder is removed from the DOM, the portaled
 * content is automatically cleaned up.
 *
 * @param props - PortalProps with optional target element
 * @param children - Function that returns the content to portal
 *
 * @returns A placeholder element in the original tree
 *
 * @example
 * ```ts
 * // Works with Show — auto-cleanup when condition becomes false
 * Show(
 *   { when: isOpen },
 *   () => Portal({}, () =>
 *     h('div', { class: 'modal' }, 'Hello!'),
 *   ),
 * );
 * ```
 */
export function Portal(props: PortalProps, children: () => HTMLElement): HTMLElement
{
    const target = props.target ?? document.body;
    const content = children();

    target.appendChild(content);

    // Create an invisible placeholder in the original tree
    const placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.setAttribute('data-quantum-portal', '');

    const observer = new MutationObserver((mutations) =>
    {
        for (const mutation of mutations)
        {
            for (const removed of mutation.removedNodes)
            {
                if (removed === placeholder || removed.contains(placeholder))
                {
                    // Placeholder was removed → clean up portaled content
                    cleanup();
                    return;
                }
            }
        }
    });

    // Start observing — we need to wait until placeholder is in the DOM
    // Use requestAnimationFrame to defer until after current render
    requestAnimationFrame(() =>
    {
        const root = placeholder.parentElement;
        if (root)
        {
            observer.observe(root, { childList: true, subtree: true });
        }
    });

    function cleanup(): void
    {
        observer.disconnect();

        if (target.contains(content))
        {
            destroyComponent(content);
            target.removeChild(content);
        }
    }

    // Store cleanup function for manual use
    (placeholder as unknown as { __quantum_portal_cleanup: () => void }).__quantum_portal_cleanup = cleanup;

    return placeholder;
}

/**
 * Manually removes a Portal's content from its target.
 *
 * Usually not needed — Portal auto-cleans when its placeholder
 * is removed from the DOM. But available for edge cases.
 *
 * @param placeholder - The placeholder element returned by Portal()
 */
export function destroyPortal(placeholder: HTMLElement): void
{
    const cleanup = (placeholder as unknown as { __quantum_portal_cleanup?: () => void })
        .__quantum_portal_cleanup;

    if (cleanup)
    {
        cleanup();
    }
}
