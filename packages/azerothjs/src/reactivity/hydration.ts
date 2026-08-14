/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Hydration adopts server-rendered DOM instead of recreating it.
 *
 * The obstacle is evaluation order: h() evaluates children inside-out, an inner call
 * completing before its outer one, so a child cannot claim its server node top-down while
 * the tree is still being built. So in 'hydrate' mode h() and the control-flow components
 * return a lightweight {@link HydrationNode} descriptor instead of DOM. Once the whole tree
 * of descriptors exists, hydrate() walks it top-down against the server DOM through a
 * {@link HydrationCursor}, claiming each existing node and wiring listeners and effects
 * onto it.
 *
 * These are the DOM-free primitives shared by the renderer and the component layer;
 * element-specific adoption lives in the renderer. Any structural mismatch throws
 * {@link HydrationMismatchError}, and hydrate() falls back to a full client render, so the
 * app always boots.
 */

import { getOwner, runWithOwner } from './create-root.ts';

/**
 * A hydration descriptor returned by h()/control-flow components while 'hydrate' mode is
 * active (cast to HTMLElement so it composes like a real element). Its hydrate() method
 * adopts the matching server node(s) from a cursor.
 */
export interface HydrationNode
{
    readonly __hydrate: true;

    /** Adopts this node's DOM from `cursor`, advancing it past the consumed nodes. */
    hydrate(cursor: HydrationCursor): void;
}

/** Whether `x` is a {@link HydrationNode} descriptor. */
export function isHydrationNode(x: unknown): x is HydrationNode
{
    return typeof x === 'object' && x !== null && (x as { __hydrate?: unknown }).__hydrate === true;
}

/**
 * Wraps an adoption routine as a {@link HydrationNode}.
 *
 * The walk invokes `hydrate` AFTER the component stack that created the descriptor has
 * returned, under the container's ambient owner - so anything adoption creates (effects,
 * route slots, row builds) would lose the creation scope's CONTEXT: a RouterProvider or
 * theme provided on a component scope is invisible from the container, and a Link inside
 * a hydrated row threw "found no router" while the same tree worked in dom mode, where
 * construction is synchronous inside the provider. Capture the creation owner and adopt
 * under it, so hydrate-mode ownership and context match dom mode's.
 *
 * @param hydrate - Claims nodes from a cursor.
 */
export function hydrationNode(hydrate: (cursor: HydrationCursor) => void): HydrationNode
{
    const owner = getOwner();
    return { __hydrate: true, hydrate: (cursor: HydrationCursor): void => runWithOwner(owner, () => hydrate(cursor)) };
}

/**
 * Thrown when server-rendered DOM does not structurally match the client tree (wrong
 * tag, missing node, absent marker, or extra node). hydrate() catches it and falls back
 * to a full client render, so a mismatch degrades gracefully rather than breaking boot.
 */
export class HydrationMismatchError extends Error
{
    constructor(message: string)
    {
        super(`[azeroth hydrate] ${ message }`);
        this.name = 'HydrationMismatchError';
    }
}

/**
 * Copies symbol-keyed properties - the destroy hooks the component layer attaches - from a
 * descriptor onto the real element it was adopted into, so teardown finds them on the live
 * node after hydration.
 */
export function transferCarriedSymbols(from: object, to: object): void
{
    for (const sym of Object.getOwnPropertySymbols(from))
    {
        (to as Record<symbol, unknown>)[sym] = (from as Record<symbol, unknown>)[sym];
    }
}

/**
 * A read cursor over a parent's children, adopting server-rendered DOM in source order.
 *
 * It snapshots `childNodes` at construction, so a later DOM mutation - a control-flow swap,
 * an anchor removal - cannot shift it. Each `take*` method claims the next node and
 * advances, throwing {@link HydrationMismatchError} on anything unexpected.
 *
 * Two marker schemes are understood, with distinct sigils so nesting resolves correctly:
 * reactive-hole anchors (comment data `[` and `]`) and balanced control-flow anchors
 * (`azc:type` and `/azc`).
 *
 * @example
 * // <div id="root"><p>hi</p>text</div>
 * const cursor = new HydrationCursor(document.getElementById('root')!);
 * cursor.takeElement('p'); // claims <p>, advances
 * cursor.takeText();       // claims the trailing "text" node
 */
export class HydrationCursor
{
    /** The parent whose children are being adopted; also the target of live DOM operations. */
    public readonly parent: Node;

    readonly #nodes: ChildNode[];

    #index: number = 0;

    /**
     * @param parent - The node whose children are adopted, and the target for live DOM
     *                 operations such as patching a reactive hole.
     * @param nodes - An explicit list to walk instead of `parent`'s live children. Used for a
     *                control-flow component's content, the slice between its comment markers,
     *                whose nodes are siblings of those markers rather than a child list.
     */
    constructor(parent: Node, nodes?: ChildNode[])
    {
        this.parent = parent;
        this.#nodes = nodes ?? Array.from(parent.childNodes);
    }

    /** The next unclaimed node, or null at the end. Does not advance. */
    public peek(): ChildNode | null
    {
        return this.#nodes[this.#index] ?? null;
    }

    /** The next unclaimed node if it is an element, otherwise null. Does not advance. */
    public peekElement(): HTMLElement | null
    {
        const node = this.peek();
        return node !== null && node.nodeType === 1 ? node as HTMLElement : null;
    }

    /**
     * Claims the next node, which must be an element.
     *
     * @param expectedTag - When given, the tag must match case-insensitively.
     * @throws {@link HydrationMismatchError} If the next node is not that element.
     */
    public takeElement(expectedTag?: string): HTMLElement
    {
        // The HTML parser wraps a table's rows in a <tbody> that the client's programmatic DOM
        // never creates, so a server row sits one level deeper than the descriptor expects. When
        // a non-tbody element is expected but the cursor is at one, splice its children into the
        // walk so the row is adopted directly. An EXPLICIT <tbody> is expected as 'tbody' and
        // matches below without unwrapping, so only the parser-inserted one is flattened.
        if (expectedTag !== undefined && expectedTag.toLowerCase() !== 'tbody')
        {
            const at = this.#nodes[this.#index];
            if (at && at.nodeType === 1 && (at as HTMLElement).tagName === 'TBODY')
            {
                this.#nodes.splice(this.#index, 1, ...Array.from(at.childNodes));
            }
        }

        const node = this.#nodes[this.#index];

        if (!node || node.nodeType !== 1)
        {
            throw new HydrationMismatchError(`expected <${ expectedTag ?? 'element' }>, found ${ describe(node) }`);
        }

        const el = node as HTMLElement;

        if (expectedTag !== undefined && el.tagName.toLowerCase() !== expectedTag.toLowerCase())
        {
            throw new HydrationMismatchError(`expected <${ expectedTag }>, found <${ el.tagName.toLowerCase() }>`);
        }

        this.#index++;
        return el;
    }

    /**
     * Claims the next node, which must be text.
     *
     * @throws {@link HydrationMismatchError} If the next node is not text.
     */
    public takeText(): Text
    {
        const node = this.#nodes[this.#index];

        if (!node || node.nodeType !== 3)
        {
            throw new HydrationMismatchError(`expected text node, found ${ describe(node) }`);
        }

        this.#index++;
        return node as Text;
    }

    /**
     * Claims the opening reactive-hole anchor, the comment `<!--[-->`.
     *
     * @throws {@link HydrationMismatchError} If the next node is not that anchor.
     */
    public takeOpenAnchor(): void
    {
        const node = this.#nodes[this.#index];

        if (!node || node.nodeType !== 8 || (node as Comment).data !== '[')
        {
            throw new HydrationMismatchError(`expected reactive-hole open anchor, found ${ describe(node) }`);
        }

        this.#index++;
    }

    /**
     * Claims everything up to and including the closing reactive-hole anchor `<!--]-->`.
     *
     * @returns The content between the anchors, plus the close anchor itself.
     * @throws {@link HydrationMismatchError} If no close anchor is found.
     */
    public takeUntilCloseAnchor(): { content: ChildNode[]; closeAnchor: Comment }
    {
        const content: ChildNode[] = [];

        while (this.#index < this.#nodes.length)
        {
            const node = this.#nodes[this.#index];
            if (node === undefined)
            {
                break; // falls through to the unterminated-anchor error below
            }

            if (node.nodeType === 8 && (node as Comment).data === ']')
            {
                this.#index++;
                return { content, closeAnchor: node as Comment };
            }

            content.push(node);
            this.#index++;
        }

        throw new HydrationMismatchError('unterminated reactive-hole anchor');
    }

    /**
     * Claims a control-flow open anchor `<!--azc:type-->`.
     *
     * @returns The comment node, which the component keeps as the live start marker it
     *          reuses for later swaps.
     * @throws {@link HydrationMismatchError} If the next node is not such an anchor.
     */
    public takeCoOpen(): Comment
    {
        const node = this.#nodes[this.#index];

        if (!node || node.nodeType !== 8 || !(node as Comment).data.startsWith('azc:'))
        {
            throw new HydrationMismatchError(`expected control-flow open anchor, found ${ describe(node) }`);
        }

        this.#index++;
        return node as Comment;
    }

    /**
     * Claims everything up to the balanced control-flow close anchor `<!--/azc-->`, then
     * consumes that close.
     *
     * Balanced means nested ranges are skipped: each `azc:*` raises the depth and each
     * `/azc` lowers it, so the close returned matches the open already claimed by
     * {@link takeCoOpen}. Reactive-hole anchors use a different sigil and count as ordinary
     * content.
     *
     * @returns The content between the markers, plus the matching close marker.
     * @throws {@link HydrationMismatchError} If no matching close anchor is found.
     */
    public takeCoBalanced(): { content: ChildNode[]; end: Comment }
    {
        const content: ChildNode[] = [];
        let depth = 0;

        while (this.#index < this.#nodes.length)
        {
            const node = this.#nodes[this.#index];
            if (node === undefined)
            {
                break; // falls through to the unterminated-anchor error below
            }

            if (node.nodeType === 8)
            {
                const data = (node as Comment).data;

                if (data.startsWith('azc:'))
                {
                    depth++;
                }
                else if (data === '/azc')
                {
                    if (depth === 0)
                    {
                        this.#index++;
                        return { content, end: node as Comment };
                    }
                    depth--;
                }
            }

            content.push(node);
            this.#index++;
        }

        throw new HydrationMismatchError('unterminated control-flow anchor');
    }

    /**
     * Asserts every node in this cursor's range was claimed. A leftover means the server
     * rendered MORE than the client expects, which the take* methods cannot catch on their
     * own: they detect a missing or wrong node, never an extra one.
     *
     * @param context - Short label for the mismatch message, such as `<div>`.
     * @throws {@link HydrationMismatchError} If any node remains unclaimed.
     */
    public assertExhausted(context: string): void
    {
        if (this.#index < this.#nodes.length)
        {
            const extra = this.#nodes.length - this.#index;
            throw new HydrationMismatchError(`${ context }: server rendered ${ extra } unexpected extra node(s), starting with ${ describe(this.#nodes[this.#index]) }`);
        }
    }
}

/** A short label for a node in mismatch messages: `<div>`, `text node`, `comment "["`. */
function describe(node: ChildNode | null | undefined): string
{
    if (!node)
    {
        return 'end of children';
    }

    if (node.nodeType === 1)
    {
        return `<${ (node as HTMLElement).tagName.toLowerCase() }>`;
    }

    if (node.nodeType === 3)
    {
        return 'text node';
    }

    if (node.nodeType === 8)
    {
        return `comment "${ (node as Comment).data }"`;
    }

    return `node type ${ node.nodeType }`;
}
