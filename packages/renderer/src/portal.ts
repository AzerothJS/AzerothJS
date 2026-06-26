/**
 * MODULE: renderer/portal
 *
 * <Portal> renders its children into a DIFFERENT part of the DOM tree, outside the
 * component's parent hierarchy. It returns an invisible placeholder where it was declared
 * and appends the real content to a target (default document.body). This is how modals,
 * tooltips, dropdowns, and toasts escape ancestor constraints - overflow:hidden clipping,
 * z-index stacking contexts, and a CSS transform breaking position:fixed.
 *
 * AUTO-CLEANUP: one shared MutationObserver watches all portal placeholders; when a
 * placeholder leaves the document (e.g. a surrounding <Show> toggles to false), the portaled
 * content is disposed and removed from the target automatically. Cleanup also runs on the
 * surrounding root's disposal and via destroyPortal(); all three paths are idempotent. The
 * single shared observer (plus a registry) keeps cost flat in the number of portals and
 * disconnects when the last one is gone. The observer/registry helpers below are internal.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createRoot, onRootDispose, isStringMode, isHydrating, runInMode, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
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
 * One shared MutationObserver for ALL portals. A per-portal observer on
 * `document` with `subtree: true` made every DOM mutation anywhere on the
 * page fan out to N callbacks, and a placeholder that never reached the
 * document kept its observer connected forever. One observer plus a registry
 * keeps the cost flat in the number of portals and disconnects itself when
 * the last portal cleans up.
 *
 * @internal
 */
const portalRegistry = new Map<HTMLElement, () => void>();

/** @internal */
let sharedObserver: MutationObserver | null = null;

/**
 * Registers a placeholder for removal watching, lazily connecting the shared
 * observer on first use.
 *
 * @internal
 */
function watchPlaceholder(placeholder: HTMLElement, cleanup: () => void): void
{
    portalRegistry.set(placeholder, cleanup);

    if (sharedObserver === null)
    {
        sharedObserver = new MutationObserver(onPortalMutations);
        sharedObserver.observe(document, { childList: true, subtree: true });
    }
}

/**
 * Unregisters a placeholder, disconnecting the shared observer when no
 * portals remain.
 *
 * @internal
 */
function unwatchPlaceholder(placeholder: HTMLElement): void
{
    portalRegistry.delete(placeholder);

    if (portalRegistry.size === 0 && sharedObserver !== null)
    {
        sharedObserver.disconnect();
        sharedObserver = null;
    }
}

/** @internal */
function onPortalMutations(mutations: MutationRecord[]): void
{
    // Snapshot: a cleanup may unregister entries (and other portals) as it
    // runs user teardown.
    for (const [placeholder, cleanup] of Array.from(portalRegistry))
    {
        // Cheap check first: still in the document means nothing to do.
        if (document.contains(placeholder))
        {
            continue;
        }

        if (mutationsRemovedNode(mutations, placeholder))
        {
            cleanup();
        }
    }
}

/**
 * Whether this mutation batch actually removed `placeholder` (directly or via
 * an ancestor). Required so a placeholder that merely hasn't been inserted
 * yet is not cleaned up prematurely.
 *
 * @internal
 */
function mutationsRemovedNode(mutations: MutationRecord[], placeholder: HTMLElement): boolean
{
    for (const mutation of mutations)
    {
        for (const removed of mutation.removedNodes)
        {
            if (removed === placeholder || (removed instanceof Node && removed.contains(placeholder)))
            {
                return true;
            }
        }
    }

    return false;
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
 * Portal
 *
 * PURPOSE:
 * Builds `children` and appends them to `target` (default document.body), returning a hidden
 * placeholder in the local tree. The content is auto-removed when the placeholder leaves the DOM.
 *
 * WHY IT EXISTS:
 * Some UI (modals, tooltips, toasts) must escape its ancestors' overflow/z-index/transform to
 * render correctly at the top of the page. Doing this by hand (appendChild to body + manual
 * removal on unmount) leaks the content and its effects if cleanup is forgotten. Portal
 * relocates the content AND owns its lifetime, tying removal to the placeholder.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; a relocation component. Mode-dispatched: on the client it relocates to
 * `target`; in SSR it emits content INLINE (no body to escape into) inside a contents anchor;
 * on hydration it discards the inline copy and rebuilds the portal at the real target (v1 does
 * not adopt portaled content in place).
 *
 * INPUT CONTRACT:
 * - props.children: a thunk building the content element.
 * - props.target: optional host element; defaults to document.body.
 *
 * OUTPUT CONTRACT:
 * - Returns a hidden <span> placeholder for the local tree; the content lives under `target`.
 *
 * WHY THIS DESIGN:
 * Content is built in its own createRoot so its effects are owned here (it has no local-tree
 * parent whose removal would dispose them). A single shared MutationObserver plus a registry
 * watches all placeholders - cheaper than one observer per portal and self-disconnecting when
 * none remain. cleanup() is reachable from the observer, the surrounding root's onRootDispose,
 * and destroyPortal(), and is idempotent so any combination is safe.
 *
 * WHEN TO USE:
 * For overlays that must render outside their local DOM position: modals, tooltips, dropdowns,
 * toasts, popovers.
 *
 * WHEN NOT TO USE:
 * For content that belongs in the normal flow. Not as a general "move this node" tool - the
 * content's lifetime is bound to the placeholder.
 *
 * EDGE CASES:
 * - Cleanup fires only when the placeholder is actually removed (directly or via an ancestor),
 *   not when it simply has not been inserted yet.
 * - SSR renders inline; the first client hydration relocates to the target and drops the copy.
 *
 * PERFORMANCE NOTES:
 * One shared observer across all portals (flat cost in portal count); cleanup is O(1) per portal.
 *
 * DEVELOPER WARNING:
 * The return value is the PLACEHOLDER, not the content - keep it in the local tree so its
 * removal triggers cleanup. Removing the content from `target` directly bypasses the
 * bookkeeping; use {@link destroyPortal} or let placeholder removal handle it.
 *
 * @param props - {@link PortalProps}: `children`, optional `target`.
 * @returns A hidden placeholder element for the local tree.
 * @see {@link destroyPortal}
 * @example
 * Portal({ children: () => h('div', { class: 'modal' }, h('button', { onClick: close }, 'Close')) });
 * // into a specific layer:
 * Portal({ target: tooltipLayer, children: () => h('div', { class: 'tooltip' }, 'Tip') });
 */
export function Portal(props: PortalProps): HTMLElement
{
    // Server-side rendering.
    // There is no document.body to escape into on the server, so emit
    // the content INLINE where the portal is declared. The client
    // relocates it to the real target on hydration.
    if (isStringMode())
    {
        return wrapContentsAnchored('portal', serializeChild(props.children())) as unknown as HTMLElement;
    }

    // Hydration.
    // Portals can't escape their parent on the server, so the content was
    // rendered inline between comment markers. On the client, discard that
    // inline copy and the markers, then build the portal fresh (relocating
    // content to its real target) and leave its placeholder where the markers
    // were. v1 does not adopt portaled content in place.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const start = cursor.takeCoOpen();
            const { content, end } = cursor.takeCoBalanced();
            const parent = cursor.parent;

            const placeholder = runInMode('dom', () => Portal(props));
            parent.insertBefore(placeholder, start);
            for (const node of content)
            {
                parent.removeChild(node);
            }
            parent.removeChild(start);
            parent.removeChild(end);
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

    let cleaned = false;

    /**
     * Disposes the content's reactive effects, removes it from the
     * target, and unregisters from the shared observer.
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

        unwatchPlaceholder(placeholder);
        contentDispose();

        if (target.contains(content))
        {
            destroyComponent(content);
            target.removeChild(content);
        }
    }

    // Watch for the placeholder being detached from the document, at any
    // ancestor level. Registered before the placeholder is returned so a
    // synchronous removal in the same tick doesn't race the setup.
    watchPlaceholder(placeholder, cleanup);

    // If the SURROUNDING reactive scope tears down (the component or
    // route that mounted this Portal unmounts), clean up
    // synchronously - don't wait on the placeholder-removal mutation
    // being observed. The shared observer stays as the backup for
    // removals that happen outside a reactive scope's teardown.
    onRootDispose(cleanup);

    // Store cleanup function for manual use via destroyPortal().
    // Symbol-keyed so user code can't collide with us.
    setPortalCleanup(placeholder, cleanup);

    return placeholder;
}

/**
 * destroyPortal
 *
 * PURPOSE:
 * Manually disposes a Portal's content and removes it from its target, given the placeholder
 * {@link Portal} returned.
 *
 * WHY IT EXISTS:
 * Portal auto-cleans when its placeholder leaves the DOM, but some flows tear content down
 * imperatively (e.g. a portal kept at the top level with no surrounding reactive scope). This
 * is the explicit hook for those cases.
 *
 * INPUT CONTRACT:
 * - placeholder: the element returned by {@link Portal}; a non-portal element is a safe no-op.
 *
 * OUTPUT CONTRACT:
 * - Returns void; idempotent (the underlying cleanup runs at most once).
 *
 * WHEN NOT TO USE:
 * When the placeholder sits in a reactive/DOM scope that will remove it - auto-cleanup already
 * handles that.
 *
 * @param placeholder - The placeholder element returned by {@link Portal}.
 * @returns void
 * @see {@link Portal}
 * @example
 * const el = Portal({ children: () => h('div', {}, 'Modal') });
 * destroyPortal(el); // removes the modal from its target
 */
export function destroyPortal(placeholder: HTMLElement): void
{
    const cleanup = getPortalCleanup(placeholder);

    if (cleanup)
    {
        cleanup();
    }
}
