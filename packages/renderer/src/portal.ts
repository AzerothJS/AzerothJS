// ============================================================================
// AZEROTHJS — Portal (Render Outside Parent)
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

import type { DisposeFn } from '@azerothjs/reactivity';
import { createRoot, onRootDispose } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';

/**
 * Storage key for the portal's cleanup function on the placeholder
 * element. Using a Symbol (instead of a string property name) keeps
 * user code from accidentally stomping on the cleanup hook and
 * matches the pattern used elsewhere in AzerothJS for element-
 * attached state.
 *
 * @internal
 */
const PORTAL_CLEANUP = Symbol('azeroth_portal_cleanup');

/**
 * The minimal shape we need to read or write a Symbol-keyed
 * property on a DOM element.
 *
 * @internal
 */
interface SymbolStore { [key: symbol]: unknown }

/**
 * Reads the cleanup function attached to a portal placeholder, or
 * `undefined` if the element isn't a portal placeholder (or has
 * already been cleaned up).
 *
 * @internal
 */
function getPortalCleanup(el: HTMLElement): (() => void) | undefined
{
    return (el as unknown as SymbolStore)[PORTAL_CLEANUP] as
        (() => void) | undefined;
}

/**
 * Attaches a cleanup function to a portal placeholder so
 * `destroyPortal()` (or the MutationObserver) can find it later.
 *
 * @internal
 */
function setPortalCleanup(el: HTMLElement, cleanup: () => void): void
{
    (el as unknown as SymbolStore)[PORTAL_CLEANUP] = cleanup;
}

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

    // Build the portaled content inside its OWN root. The content
    // lives outside the parent tree, so it can't rely on a parent
    // element being removed to dispose its reactive effects — we
    // own them here and tear them down in cleanup() instead. Without
    // this, a manual destroyPortal() (or a portal at the top level
    // with no surrounding scope) would remove the DOM but leak the
    // effects, which keep mutating a detached node.
    let content!: HTMLElement;
    let contentDispose!: DisposeFn;
    createRoot((d) =>
    {
        contentDispose = d;
        content = children();
    });

    // Append the content to the target (outside parent tree)
    target.appendChild(content);

    // Create an invisible placeholder in the original tree
    const placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.setAttribute('data-azeroth-portal', '');

    // ── Auto-cleanup with MutationObserver ───────────────────
    //
    // Watch for the placeholder being detached from the document.
    // We observe `document` with `subtree: true` from the start so
    // that:
    //   1. A synchronous removal (in the same tick as Portal())
    //      doesn't race the observer setup.
    //   2. A removal at any ancestor level is caught — not just
    //      the immediate parent.
    //
    const observer = new MutationObserver((mutations) =>
    {
        // Cheap check: if the placeholder is still in the document,
        // there's nothing to do for this batch.
        if (document.contains(placeholder)) return;

        for (const mutation of mutations)
        {
            for (const removed of mutation.removedNodes)
            {
                if (removed === placeholder || (removed instanceof Node && removed.contains(placeholder)))
                {
                    cleanup();
                    return;
                }
            }
        }
    });

    observer.observe(document, { childList: true, subtree: true });

    let cleaned = false;

    /**
     * Disposes the content's reactive effects, removes it from the
     * target, and disconnects the MutationObserver.
     *
     * Idempotent — it can be reached from three paths (the observer,
     * `destroyPortal()`, and the surrounding scope's teardown), and
     * any of them may fire more than once.
     */
    function cleanup(): void
    {
        if (cleaned) return;
        cleaned = true;

        observer.disconnect();
        contentDispose();

        if (target.contains(content))
        {
            destroyComponent(content);
            target.removeChild(content);
        }
    }

    // If the SURROUNDING reactive scope tears down (the component or
    // route that mounted this Portal unmounts), clean up
    // synchronously — don't wait on the placeholder-removal mutation
    // being observed. The MutationObserver above stays as the backup
    // for removals that happen outside a reactive scope's teardown.
    onRootDispose(cleanup);

    // Store cleanup function for manual use via destroyPortal().
    // Symbol-keyed so user code can't collide with us.
    setPortalCleanup(placeholder, cleanup);

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
    const cleanup = getPortalCleanup(placeholder);

    if (cleanup)
    {
        cleanup();
    }
}
