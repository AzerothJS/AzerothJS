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
 * adopts the matching server node(s) from a cursor. Only {@link hydrationNode} makes one.
 */
export class HydrationNode
{
    // The brand: data cannot hold a private field, and transferCarriedSymbols never copies one.
    readonly #brand = true;

    /** Adopts this node's DOM from `cursor`, advancing it past the consumed nodes. */
    public readonly hydrate: (cursor: HydrationCursor) => void;

    /** Use {@link hydrationNode}. */
    constructor(hydrate: (cursor: HydrationCursor) => void)
    {
        this.hydrate = hydrate;
    }

    /** Whether `x` was built by this class. */
    public static is(x: unknown): x is HydrationNode
    {
        return typeof x === 'object' && x !== null && #brand in x;
    }
}

/** Whether `x` is a descriptor {@link hydrationNode} made. */
export function isHydrationNode(x: unknown): x is HydrationNode
{
    return HydrationNode.is(x);
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
    return new HydrationNode((cursor: HydrationCursor): void => runWithOwner(owner, () => hydrate(cursor)));
}

/**
 * Thrown when server-rendered DOM does not structurally match the client tree (wrong
 * tag, missing node, absent marker, or extra node). hydrate() catches it and falls back
 * to a full client render, so a mismatch degrades gracefully rather than breaking boot.
 */
export class HydrationMismatchError extends Error
{
    constructor(message: string, parent?: Node | null, stoppedAt: Node | null = null)
    {
        // A table cursor can span nodes inside the tbody that the parser inserted.
        const host = (stoppedAt && nodeProperty(stoppedAt, 'parentNode')) ?? parent;
        const location = host ? ` (parent ${ describe(host) }, stopped at ${ describe(stoppedAt) })` : '';
        super(`[azeroth hydrate] ${ message }${ location }`);
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

// The tbodies the HTML parser put around server rows, which the client's DOM never builds.
const impliedBodies = new WeakSet<Node>();

/** Whether `node` is a tbody the HTML parser implied around server rows. */
export function isImpliedTbody(node: Node): boolean
{
    return impliedBodies.has(node);
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
    #staticTextEnd = -1;

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

    /** The node the last take claimed, or null before the first. */
    public lastClaimed(): ChildNode | null
    {
        return this.#nodes[this.#index - 1] ?? null;
    }

    /** The next unclaimed node if it is an element, otherwise null. Does not advance. */
    public peekElement(): HTMLElement | null
    {
        const node = this.peek();
        return node !== null && nodeProperty(node, 'nodeType') === 1 ? node as HTMLElement : null;
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
            if (at && nodeProperty(at, 'nodeType') === 1 && elementTagName(at as Element) === 'TBODY')
            {
                impliedBodies.add(at);
                this.#nodes.splice(this.#index, 1, ...Array.from(at.childNodes));
            }
        }

        const node = this.#nodes[this.#index];

        if (!node || nodeProperty(node, 'nodeType') !== 1)
        {
            throw new HydrationMismatchError(`expected <${ expectedTag ?? 'element' }>`, this.parent, node);
        }

        const el = node as HTMLElement;

        if (expectedTag !== undefined && elementTagName(el).toLowerCase() !== expectedTag.toLowerCase())
        {
            throw new HydrationMismatchError(`expected <${ expectedTag }>`, this.parent, el);
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
            throw new HydrationMismatchError('expected text node', this.parent, node);
        }

        this.#index++;
        return node as Text;
    }

    /**
     * Adopts escaped static children as the HTML parser served them. Adjacent values can
     * share one Text node, and an empty string can produce none. Prefer an available
     * Text node so a DOM with explicitly split text retains the same nodes.
     */
    public takeStaticText(value: string | number): void
    {
        if (this.peek()?.nodeType !== 3 && (value === '' || this.#index === this.#staticTextEnd))
        {
            return;
        }

        this.takeText();
        this.#staticTextEnd = this.#index;
    }

    /**
     * Claims the opening reactive-hole anchor, the comment `<!--[-->`.
     *
     * @returns The anchor, which bounds the hole's range from then on.
     * @throws {@link HydrationMismatchError} If the next node is not that anchor.
     */
    public takeOpenAnchor(): Comment
    {
        const node = this.#nodes[this.#index];

        if (!node || node.nodeType !== 8 || (node as Comment).data !== '[')
        {
            throw new HydrationMismatchError('expected reactive-hole open anchor', this.parent, node);
        }

        this.#index++;
        return node as Comment;
    }

    /**
     * Claims everything up to and including the closing reactive-hole anchor `<!--]-->`.
     * A hole whose value holds another hole nests a whole `[` `]` pair inside its own range.
     *
     * @returns The content between the anchors, plus the close anchor itself.
     * @throws {@link HydrationMismatchError} If no close anchor is found.
     */
    public takeUntilCloseAnchor(): { content: ChildNode[]; closeAnchor: Comment }
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

                if (data === '[')
                {
                    depth++;
                }
                else if (data === ']')
                {
                    if (depth === 0)
                    {
                        this.#index++;
                        return { content, closeAnchor: node as Comment };
                    }
                    depth--;
                }
            }

            content.push(node);
            this.#index++;
        }

        throw new HydrationMismatchError('unterminated reactive-hole anchor', this.parent);
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
            throw new HydrationMismatchError('expected control-flow open anchor', this.parent, node);
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

        throw new HydrationMismatchError('unterminated control-flow anchor', this.parent);
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
            throw new HydrationMismatchError(`${ context }: server rendered ${ extra } unexpected extra node(s)`, this.parent, this.peek());
        }
    }
}

// A standalone cursor can receive a DOM from a caller in a process with no global
// Node or Element. Read the base DOM property below any custom-element override.
function standaloneProperty<T extends Node, K extends keyof T>(node: T, key: K): T[K]
{
    let declaringPrototype = node;
    for (let proto = Object.getPrototypeOf(node) as T | null; proto; proto = Object.getPrototypeOf(proto) as T | null)
    {
        if (Object.hasOwn(proto, key))
        {
            declaringPrototype = proto;
        }
    }
    return Reflect.get(declaringPrototype, key, node);
}

// Named form controls can hide DOM properties. Custom elements can also override them.
function nodeProperty<K extends 'parentNode' | 'nodeType'>(node: Node, key: K): Node[K]
{
    return typeof Node === 'undefined' ? standaloneProperty(node, key) : Reflect.get(Node.prototype, key, node);
}

function elementTagName(el: Element): string
{
    return typeof Element === 'undefined' ? standaloneProperty(el, 'tagName') : Reflect.get(Element.prototype, 'tagName', el);
}

/** A short label for a node in mismatch messages: `<div>`, `text node`, `comment "["`. */
function describe(node: Node | null): string
{
    if (!node)
    {
        return 'end of children';
    }

    const type = nodeProperty(node, 'nodeType');
    if (type === 1)
    {
        return `<${ elementTagName(node as Element).toLowerCase() }>`;
    }

    if (type === 3)
    {
        return 'text node';
    }

    if (type === 8)
    {
        const marker = (node as Comment).data;
        if (marker === '[' || marker === ']')
        {
            return `comment "${ marker }"`;
        }
        return 'comment';
    }

    return `node type ${ type }`;
}
