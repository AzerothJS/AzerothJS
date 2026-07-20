/**
 * MODULE: component/co-range
 *
 * The shared "control-flow range" (co-range): the placement abstraction every control-flow
 * component (Show, Switch, Dynamic, For, ErrorBoundary) uses for its DOM output, on both the
 * client render and hydration paths.
 *
 * WHY COMMENTS, NOT A WRAPPER: rendering dynamic content inside a wrapper element
 * (`<span style="display:contents">`) keeps it out of LAYOUT but NOT out of the DOM tree, so the
 * wrapper breaks `<table>`/`<tbody>`, `<select>`, and `<ul>` (which allow only specific child
 * tags) and defeats structural selectors like `tbody > tr`. Instead, the content is bracketed
 * by two comment markers and returned as a DocumentFragment: appending the fragment moves the
 * markers (and the content between them) directly into the real parent, so the content becomes
 * the parent's OWN children. Comments are valid in every context.
 *
 * WHY HERE: it lives in @azerothjs/component (not the renderer) because it needs
 * destroyComponent, and BOTH the renderer's control-flow components and this package's
 * ErrorBoundary use it - and renderer depends on component, not the reverse. These functions
 * are the framework's control-flow contract, not app-facing API.
 */

import { HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from './destroy-component.ts';

/**
 * Where a control-flow component's content lives: a marker-bounded range inside an arbitrary
 * parent. The same shape serves the fresh client render (markers created in a fragment) and
 * hydration (markers adopted from the server-rendered comment anchors).
 */
export interface CoTarget
{
    /** The live parent the content is a child of - a GETTER, because on the client path the parent changes the instant the returned fragment is appended (detached fragment -> real container). */
    parent: () => Node;

    /** The node immediately before the first content node (the start marker). */
    start: ChildNode;

    /** The node immediately after the last content node (the end marker), used as the insertion anchor. */
    end: ChildNode;
}

/**
 * Builds a {@link CoTarget} backed by two comment markers: the content lives between them in
 * whatever parent the markers currently sit in.
 *
 * @param start - The start-marker comment.
 * @param end - The end-marker comment.
 * @returns A target whose `parent()` reads the markers' current parent live.
 */
export function coMarkerTarget(start: ChildNode, end: ChildNode): CoTarget
{
    return { parent: (): Node => end.parentNode as Node, start, end };
}

/**
 * Adopts a control-flow component's server-rendered marker range from a hydration cursor:
 * claims the open/close comment anchors (reused as the live markers for later swaps) and returns
 * a target plus a cursor over the content between them for the component's hydration first run.
 *
 * @param cursor - The hydration cursor positioned at the component's open anchor.
 * @returns The adopted {@link CoTarget} and a content cursor over the in-range nodes.
 */
export function adoptCoRange(cursor: HydrationCursor): { target: CoTarget; contentCursor: HydrationCursor }
{
    const start = cursor.takeCoOpen();
    const { content, end } = cursor.takeCoBalanced();

    return {
        target: coMarkerTarget(start, end),
        // Content nodes are siblings of the markers in cursor.parent, so the content cursor
        // shares that parent for live DOM ops (e.g. patching a reactive hole) while walking
        // only the in-range nodes.
        contentCursor: new HydrationCursor(cursor.parent, content)
    };
}

/**
 * Creates the comment-marker pair and the fragment that carries them for a fresh client render.
 * The driver renders content between the markers; the returned fragment is what the component
 * hands back to its parent.
 *
 * @param coType - The control-flow kind ('show', 'switch', ...); used only as the marker comment text (aids DOM debugging).
 * @returns The carrier fragment and the {@link CoTarget} for its marker range.
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
 * Unwraps a thunk chain (a function returning a function, e.g. a markup child that compiles to
 * `() => (() => ...)`) down to its non-function result. A control-flow component's `children`/
 * `fallback` prop is typed as returning a resolved {@link MountNode}, but the value that actually
 * reaches it can still be a thunk if the caller passed one through unresolved - `appendToCo`
 * requires an already-resolved Node (see its own doc comment), so any caller whose value might
 * still be callable must resolve it first. The bound guards a pathological getter that returns a
 * function forever; real chains are one or two deep.
 *
 * @param value - A possibly-thunked value.
 * @returns The first non-function value reached.
 */
export function resolveMountNode(value: unknown): Node | null | undefined
{
    let resolved = value;
    let depth = 0;
    while (typeof resolved === 'function' && depth < 16)
    {
        resolved = (resolved as () => unknown)();
        depth++;
    }
    return resolved as Node | null | undefined;
}

/**
 * Appends `node` as the last item in the range (before the end anchor). Used by the single-slot
 * components (Show, Switch, Dynamic, ErrorBoundary).
 *
 * CALLER CONTRACT: `node` must already be a resolved Node (or nullish) - this does NOT unwrap a
 * thunk chain. A caller whose value might still be callable (e.g. a control-flow component's
 * `children()`/`fallback()` result) must resolve it first, e.g. via {@link resolveMountNode}.
 *
 * @param target - The co-range to append into.
 * @param node - The node to insert before the end marker.
 */
export function appendToCo(target: CoTarget, node: Node | null | undefined): void
{
    // A branch may render nothing - a nullish thunk return (e.g. an omitted-but-typed
    // fallback, or `fallback={maybeNode}`). Appending nothing is a no-op.
    if (node === null || node === undefined)
    {
        return;
    }

    target.parent().insertBefore(node, target.end);
}

/**
 * Removes every content node currently in the range, running component destroy hooks on each.
 * Removal is front-to-back, one node at a time, so a MutationObserver sees each removal (Portal
 * auto-cleanup relies on this); the markers themselves are never touched.
 *
 * @param target - The co-range to clear (markers preserved).
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
