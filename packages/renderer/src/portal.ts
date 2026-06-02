// Portal renders children into a different part of the DOM tree, outside the
// component's parent hierarchy. It returns an invisible placeholder in the
// original tree and appends the real content to a target (default
// document.body).
//
// Why: modals, tooltips, dropdowns, and toasts need to render at the top level
// of the page to escape problems imposed by ancestors:
//   - overflow: hidden clipping
//   - z-index stacking context issues
//   - a CSS transform on an ancestor breaking position: fixed
//
// Cleanup: a MutationObserver watches the placeholder. When the placeholder is
// removed from the DOM (e.g. a surrounding Show toggling to false), the
// portaled content is removed from the target automatically - no manual
// cleanup needed. For example, inside Show: opening renders the Portal, which
// appends the modal to body; closing removes the placeholder, the observer
// fires, and the modal is removed from body.
//
// Without Portal: append to document.body by hand and remember to remove it
// (and dispose its effects) when the owner unmounts.
//
//     const modal = h('div', { class: 'modal' }, 'Hi');
//     document.body.appendChild(modal);
//     onUnmount(() =>
//     {
//         modal.remove(); // forget this and the modal leaks past its owner
//     });
//
// With Portal: returns a placeholder in the local tree.
//
//     Portal({
//         children: () => h('div', { class: 'modal' }, 'Hi')
//     }); // content mounts to the target, auto-cleans when the placeholder goes

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createRoot, onRootDispose, isStringMode, isHydrating, runInMode, serializeChild, wrapContents, hydrationNode } from '@azerothjs/reactivity';
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

    /**
     * Thunk that builds the content to portal into `target`.
     * A prop (not positional) so the manual API matches the
     * compiled `<Portal>...</Portal>` form.
     */
    children: () => HTMLElement;
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
 * @param props - PortalProps with `children` and optional `target`
 *
 * @returns A hidden placeholder element in the original tree
 *
 * @example
 * ```ts
 * // Render a modal into document.body
 * Portal({ children: () =>
 *   h('div', { class: 'modal-overlay' },
 *     h('div', { class: 'modal' },
 *       h('h2', {}, 'Are you sure?'),
 *       h('button', { onClick: closeModal }, 'Close')
 *     )
 *   )
 * });
 * ```
 *
 * @example
 * ```ts
 * // Render into a specific container
 * const tooltipLayer = document.getElementById('tooltip-layer')!;
 *
 * Portal({ target: tooltipLayer, children: () =>
 *   h('div', { class: 'tooltip' }, 'Helpful tip!')
 * });
 * ```
 */
export function Portal(props: PortalProps): HTMLElement
{
    // Server-side rendering.
    // There is no document.body to escape into on the server, so emit
    // the content INLINE where the portal is declared. The client
    // relocates it to the real target on hydration.
    if (isStringMode())
    {
        return wrapContents('portal', serializeChild(props.children())) as unknown as HTMLElement;
    }

    // Hydration.
    // Portals can't escape their parent on the server, so the content was
    // rendered inline. On the client, discard that inline copy and build the
    // portal fresh (relocating content to its real target). v1 does not adopt
    // portaled content in place.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const serverSpan = cursor.takeElement('span');
            const placeholder = runInMode('dom', () => Portal(props));
            serverSpan.parentNode?.replaceChild(placeholder, serverSpan);
        }) as unknown as HTMLElement;
    }

    const children = props.children;
    const target = props.target ?? document.body;

    // Build the portaled content inside its OWN root. The content
    // lives outside the parent tree, so it can't rely on a parent
    // element being removed to dispose its reactive effects - we
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

    // Auto-cleanup with MutationObserver.
    //
    // Watch for the placeholder being detached from the document.
    // We observe `document` with `subtree: true` from the start so
    // that:
    //   1. A synchronous removal (in the same tick as Portal())
    //      doesn't race the observer setup.
    //   2. A removal at any ancestor level is caught - not just
    //      the immediate parent.
    //
    const observer = new MutationObserver((mutations) =>
    {
        // Cheap check: if the placeholder is still in the document,
        // there's nothing to do for this batch.
        if (document.contains(placeholder))
        {
            return;
        }

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
     * Idempotent - it can be reached from three paths (the observer,
     * `destroyPortal()`, and the surrounding scope's teardown), and
     * any of them may fire more than once.
     */
    function cleanup(): void
    {
        if (cleaned)
        {
            return;
        }
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
    // synchronously - don't wait on the placeholder-removal mutation
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
 * Usually not needed - Portal auto-cleans when its placeholder
 * is removed from the DOM. But available for edge cases.
 *
 * @param placeholder - The placeholder element returned by Portal()
 *
 * @example
 * ```ts
 * const el = Portal({ children: () => h('div', {}, 'Modal') });
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
