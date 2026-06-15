// Shared "control-flow range": the placement abstraction control-flow
// components (Show, Switch, Dynamic, For, ErrorBoundary) use for their DOM
// output, on both the client render and hydration paths.
//
// Why: rendering dynamic content inside a wrapper element (`<span
// style="display:contents">`) keeps the content out of LAYOUT but NOT out of
// the DOM tree - so the wrapper breaks `<table>`/`<tbody>`, `<select>`, and
// `<ul>`, where only specific child tags are allowed, and defeats structural
// selectors like `tbody > tr`. Instead, bracket the content with two comment
// markers and return a DocumentFragment: appending it moves the markers (and
// the content between them) directly into the real parent, so the content
// becomes the parent's own children. Comments are valid in every context.
//
// This lives in @azerothjs/component (not the renderer) because it needs
// destroyComponent, and both the renderer's control-flow components AND this
// package's ErrorBoundary use it - and renderer depends on component, not the
// reverse.

import { HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from './define-component.ts';

/**
 * Describes where a control-flow component's content lives: a marker-bounded
 * range inside an arbitrary parent. The same shape serves the fresh client
 * render (markers created in a fragment) and hydration (markers adopted from
 * the server-rendered comment anchors).
 */
export interface CoTarget
{
    /**
     * The live parent the content is children of. A getter, not a value: on the
     * client path the parent changes the instant the returned fragment is
     * appended somewhere (the detached fragment -> the real container).
     */
    parent: () => Node;

    /** Node immediately before the first content node (the start marker). */
    start: ChildNode;

    /**
     * Node immediately after the last content node (the end marker), used as the
     * insertion anchor.
     */
    end: ChildNode;
}

/**
 * A target backed by two comment markers: the content lives between them in
 * whatever parent the markers currently sit in.
 */
export function coMarkerTarget(start: ChildNode, end: ChildNode): CoTarget
{
    return { parent: (): Node => end.parentNode as Node, start, end };
}

/**
 * Adopts a control-flow component's server-rendered marker range from a
 * hydration cursor: claims the open/close comment anchors (reused as the live
 * markers for later swaps) and returns a target plus a cursor over the content
 * between them for the component's hydration first run.
 */
export function adoptCoRange(cursor: HydrationCursor): { target: CoTarget; contentCursor: HydrationCursor }
{
    const start = cursor.takeCoOpen();
    const { content, end } = cursor.takeCoBalanced();

    return {
        target: coMarkerTarget(start, end),
        // The content nodes are siblings of the markers in `cursor.parent`, so
        // the content cursor shares that parent for live DOM ops (e.g. patching
        // a reactive hole) while walking only the in-range nodes.
        contentCursor: new HydrationCursor(cursor.parent, content)
    };
}

/**
 * Creates the comment-marker pair and the fragment that carries them for a
 * fresh client render. The driver renders content between the markers; the
 * returned fragment is what the component hands back to its parent.
 *
 * @param coType - The control-flow kind ('show', 'switch', ...) - used only as
 *                 the marker comment text, which aids debugging in the DOM.
 */
export function createCoMarkers(coType: string): { fragment: DocumentFragment; target: CoTarget }
{
    const start = document.createComment(coType);
    const end = document.createComment(`/${ coType }`);
    const fragment = document.createDocumentFragment();
    fragment.appendChild(start);
    fragment.appendChild(end);

    return { fragment, target: coMarkerTarget(start, end) };
}

/**
 * Appends `node` as the last item in the range (before the end anchor). Used by
 * the single-slot components (Show, Switch, Dynamic, ErrorBoundary).
 */
export function appendToCo(target: CoTarget, node: Node): void
{
    target.parent().insertBefore(node, target.end);
}

/**
 * Removes every content node currently in the range, running component destroy
 * hooks on each. Removal is front-to-back, one node at a time, so a
 * MutationObserver sees each removal (Portal's auto-cleanup relies on this) -
 * matching the previous span teardown semantics exactly. The markers
 * themselves are never touched. Used by the single-slot components.
 */
export function clearCo(target: CoTarget): void
{
    const parent = target.parent();
    let node: ChildNode | null = target.start.nextSibling;

    while (node !== null && node !== target.end)
    {
        const next: ChildNode | null = node.nextSibling;
        parent.removeChild(node);
        if (node instanceof HTMLElement)
        {
            destroyComponent(node);
        }
        node = next;
    }
}
