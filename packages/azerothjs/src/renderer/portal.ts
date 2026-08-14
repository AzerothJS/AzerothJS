/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Renders children into a different part of the DOM, outside the component's own hierarchy:
 * an invisible placeholder stays where the Portal was declared while the real content is
 * appended to a target, `document.body` by default. This is how modals, tooltips, dropdowns
 * and toasts escape ancestor constraints - `overflow: hidden` clipping, z-index stacking
 * contexts, and a CSS transform that breaks `position: fixed`.
 *
 * Cleanup has three entry points and all of them are idempotent: the surrounding root
 * disposing, an explicit destroyPortal(), and a shared MutationObserver that notices the
 * placeholder leaving the document, which is what makes a Portal inside a `<Show>` clean
 * itself up when the branch swaps away.
 *
 * One observer serves every portal. A per-portal observer on `document` with `subtree: true`
 * made every mutation anywhere on the page fan out to N callbacks, and a placeholder that
 * never reached the document kept its observer connected forever.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createRoot, onRootDispose, isStringMode, isHydrating, runInMode } from '../reactivity/index.ts';
import { refuseSlotHandle } from '../reactivity/slot-handle.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { destroyComponent } from '../component/index.ts';

/** Symbol-keyed so user code cannot stomp on the cleanup hook. */
const PORTAL_CLEANUP = Symbol('azeroth_portal_cleanup');

interface SymbolStore { [key: symbol]: unknown }

/** Undefined when the element is not a placeholder, or was already cleaned up. */
function getPortalCleanup(el: HTMLElement): (() => void) | undefined
{
    return (el as unknown as SymbolStore)[PORTAL_CLEANUP] as
        (() => void) | undefined;
}
function setPortalCleanup(el: HTMLElement, cleanup: () => void): void
{
    (el as unknown as SymbolStore)[PORTAL_CLEANUP] = cleanup;
}

/** The refusal hint every Portal mode shares. */
const PORTAL_SLOT_HINT = 'Place the Outlet in the normal tree; portal individual UI (a modal) from inside the routed component instead.';

/** Every live placeholder and its cleanup; see the module header for why it is shared. */
const portalRegistry = new Map<HTMLElement, () => void>();

let sharedObserver: MutationObserver | null = null;

/** Connects the shared observer lazily, on the first portal. */
function watchPlaceholder(placeholder: HTMLElement, cleanup: () => void): void
{
    portalRegistry.set(placeholder, cleanup);

    if (sharedObserver === null)
    {
        sharedObserver = new MutationObserver(onPortalMutations);
        sharedObserver.observe(document, { childList: true, subtree: true });
    }
}

/** Disconnects the shared observer once the last portal is gone. */
function unwatchPlaceholder(placeholder: HTMLElement): void
{
    portalRegistry.delete(placeholder);

    if (portalRegistry.size === 0 && sharedObserver !== null)
    {
        sharedObserver.disconnect();
        sharedObserver = null;
    }
}

function onPortalMutations(mutations: MutationRecord[]): void
{
    // Snapshot: a cleanup may unregister entries, including other portals, as it runs user
    // teardown.
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

/** Props for {@link Portal}. */
export interface PortalProps
{
    /** Where the content is appended. Defaults to `document.body`. */
    target?: HTMLElement;

    /** Builds the content. A prop rather than a positional argument, matching compiled markup. */
    children: () => HTMLElement;
}

/**
 * Builds `children`, appends them to `target`, and returns a hidden PLACEHOLDER for the
 * local tree.
 *
 * The return value is the placeholder, not the content. Keep it in the local tree: its
 * removal is what triggers cleanup, so the content's lifetime is bound to it. Removing the
 * content from `target` by hand bypasses the bookkeeping - use {@link destroyPortal}, or let
 * the placeholder's removal handle it.
 *
 * Cleanup fires when the placeholder is actually removed, directly or through an ancestor,
 * not merely because it has yet to be inserted.
 *
 * Content is built in its own root, since it has no local-tree parent whose removal would
 * dispose its effects.
 *
 * Under SSR the content is emitted INLINE, there being no body to escape into. The first
 * hydration discards that inline copy and rebuilds the portal at the real target rather than
 * adopting it in place.
 *
 * @param props - See {@link PortalProps}.
 * @returns A hidden placeholder element.
 * @example
 * Portal({
 *     children: () => h('div', { class: 'modal' }, h('button', { onClick: close }, 'Close'))
 * });
 *
 * @example
 * // Into a specific layer rather than the body.
 * Portal({ target: tooltipLayer, children: () => h('div', { class: 'tooltip' }, 'Tip') });
 *
 * @see {@link destroyPortal}
 */
export function Portal(props: PortalProps): HTMLElement
{
    // Server-side rendering.
    // There is no document.body to escape into on the server, so emit
    // the content INLINE where the portal is declared. The client
    // relocates it to the real target on hydration.
    if (isStringMode())
    {
        const child = props.children();
        // A route slot cannot live in a Portal: the segment would sit outside the route
        // tree's DOM order and outside hydration's walk. Refused in every mode, so the
        // server never serializes a segment the client would then discard.
        if (refuseSlotHandle(child, 'Portal', PORTAL_SLOT_HINT))
        {
            return wrapContentsAnchored('portal', '') as unknown as HTMLElement;
        }
        return wrapContentsAnchored('portal', serializeChild(child)) as unknown as HTMLElement;
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

    // The dom-path (and hydration-rebuild) half of the three-mode refusal. Production
    // no-op leaves NULL content and skips registration entirely, so cleanup never
    // touches a non-Node.
    if (refuseSlotHandle(content, 'Portal', PORTAL_SLOT_HINT))
    {
        contentDispose();
        const inert = document.createElement('span');
        inert.style.display = 'none';
        inert.setAttribute('data-azeroth-portal', '');
        return inert;
    }

    // Append the content to the target (outside parent tree)
    target.appendChild(content);

    // Create an invisible placeholder in the original tree
    const placeholder = document.createElement('span');
    placeholder.style.display = 'none';
    placeholder.setAttribute('data-azeroth-portal', '');

    let cleaned = false;

    /** Idempotent: three paths reach it, and any of them may fire more than once. */
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

    // Registered before the placeholder is returned, so a synchronous removal in the same tick
    // cannot race the setup.
    watchPlaceholder(placeholder, cleanup);

    // When the surrounding scope tears down, clean up synchronously rather than waiting for the
    // removal mutation to be observed. The shared observer remains the backup for removals that
    // happen outside any scope's teardown.
    onRootDispose(cleanup);

    setPortalCleanup(placeholder, cleanup);

    return placeholder;
}

/**
 * Disposes a portal's content and removes it from its target, explicitly.
 *
 * Only needed for a portal with no surrounding scope that will remove its placeholder - one
 * kept at the top level, say. Everywhere else the automatic cleanup already covers it.
 *
 * @param placeholder - The element {@link Portal} returned. Anything else is a safe no-op,
 *                      and calling twice is harmless.
 * @example
 * const placeholder = Portal({ children: () => h('div', {}, 'Modal') });
 * destroyPortal(placeholder);
 *
 * @see {@link Portal}
 */
export function destroyPortal(placeholder: HTMLElement): void
{
    const cleanup = getPortalCleanup(placeholder);

    if (cleanup)
    {
        cleanup();
    }
}
