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
 * Returns a comment node as a placeholder in the original
 * tree, while the actual content is appended to the target.
 *
 * @param props - PortalProps with optional target element
 * @param children - Function that returns the content to portal
 *
 * @returns An empty placeholder element in the original tree
 *
 * @example
 * ```ts
 * // Render a modal into document.body
 * Portal({}, () =>
 *   h('div', { class: 'modal-overlay' },
 *     h('div', { class: 'modal' },
 *       h('h2', {}, 'Are you sure?'),
 *       h('button', { onClick: closeModal }, 'Close'),
 *     ),
 *   ),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Render into a specific container
 * const tooltipLayer = document.getElementById('tooltip-layer')!;
 *
 * Portal({ target: tooltipLayer }, () =>
 *   h('div', { class: 'tooltip' }, 'Helpful tip!'),
 * );
 * ```
 */
export function Portal(props: PortalProps, children: () => HTMLElement): HTMLElement
{
    const target = props.target ?? document.body;
    const content = children();

    target.appendChild(content);

    // Return an invisible placeholder in the original tree.
    // This marker lets the component tree track where the
    // Portal was declared, even though its content is elsewhere.
    const placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.setAttribute('data-quantum-portal', '');

    // Store a reference for cleanup
    (placeholder as unknown as { __quantum_portal_content: HTMLElement }).__quantum_portal_content = content;
    (placeholder as unknown as { __quantum_portal_target: HTMLElement }).__quantum_portal_target = target;

    return placeholder;
}

/**
 * Removes a Portal's content from its target.
 *
 * Call this when destroying a component that contains a Portal
 * to clean up the portaled content.
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
    const content = (placeholder as unknown as { __quantum_portal_content?: HTMLElement })
        .__quantum_portal_content;
    const target = (placeholder as unknown as { __quantum_portal_target?: HTMLElement })
        .__quantum_portal_target;

    if (content && target && target.contains(content))
    {
        destroyComponent(content);
        target.removeChild(content);
    }
}
