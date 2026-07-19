/**
 * MODULE: reactivity/hydration
 *
 * Hydration ADOPTS server-rendered DOM instead of recreating it. The core problem:
 * h() evaluates children inside-out (an inner h() runs before its outer one), so a
 * child cannot claim its server node top-down while it is being built. The fix: in
 * 'hydrate' mode, h() and the control-flow components return a lightweight
 * {@link HydrationNode} descriptor instead of building DOM. Once the whole tree of
 * descriptors exists, hydrate() walks it TOP-DOWN against the server DOM through a
 * {@link HydrationCursor}, claiming each existing node and wiring listeners and effects
 * onto it.
 *
 * These are the DOM-free primitives shared by the renderer (h, control-flow) and
 * @azerothjs/component (ErrorBoundary). The element-specific adoption (applyProps,
 * reactive-hole text patching) lives in the renderer. On any structural mismatch a
 * {@link HydrationMismatchError} is thrown and hydrate() falls back to a full client
 * render, so the app always boots.
 */

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

/**
 * Type guard: whether `x` is a {@link HydrationNode} descriptor.
 *
 * @param x - Any value.
 * @returns true if `x` is a hydration descriptor.
 */
export function isHydrationNode(x: unknown): x is HydrationNode
{
    return typeof x === 'object' && x !== null && (x as { __hydrate?: unknown }).__hydrate === true;
}

/**
 * Wraps an adoption function as a {@link HydrationNode}.
 *
 * @param hydrate - The adoption routine that claims nodes from a cursor.
 * @returns A hydration descriptor.
 */
export function hydrationNode(hydrate: (cursor: HydrationCursor) => void): HydrationNode
{
    return { __hydrate: true, hydrate };
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
 * Copies symbol-keyed properties (e.g. the destroy hooks @azerothjs/component attaches)
 * from a descriptor onto the real element it was adopted into, so destroyComponent()
 * finds them on the live node after hydration.
 *
 * @param from - The descriptor that carried the symbols.
 * @param to - The adopted real element.
 */
export function transferCarriedSymbols(from: object, to: object): void
{
    for (const sym of Object.getOwnPropertySymbols(from))
    {
        (to as Record<symbol, unknown>)[sym] = (from as Record<symbol, unknown>)[sym];
    }
}

/**
 * HydrationCursor
 *
 * A read cursor over a parent node's children, used to adopt server-rendered DOM in
 * source order. It snapshots `childNodes` at construction so later DOM mutations (a
 * control-flow swap, anchor removal) do not shift it. The take* methods claim the next
 * node and advance; a mismatch throws {@link HydrationMismatchError}. The cursor
 * understands two marker schemes: reactive-hole anchors (comment data `[` / `]`) and
 * balanced control-flow anchors (`azc:type` / `/azc`), which use distinct sigils so
 * nesting resolves correctly.
 *
 * @example
 * // <div id="root"><p>hi</p>text</div>
 * const cursor = new HydrationCursor(document.getElementById('root')!);
 * cursor.takeElement('p'); // claims <p>, advances
 * cursor.takeText();       // claims the trailing "text" node
 */
export class HydrationCursor
{
    /** The parent node whose children are being adopted (used for live DOM ops). */
    public readonly parent: Node;

    /** Snapshot of the parent's children at construction time. @internal */
    readonly #nodes: ChildNode[];

    /** Index of the next unclaimed child. @internal */
    #index: number = 0;

    /**
     * @param parent - The node whose children are adopted (used for live DOM ops, e.g.
     *                 patching a reactive hole).
     * @param nodes - An explicit node list to walk instead of `parent`'s live children;
     *                used to hydrate a control-flow component's content (the slice
     *                between its comment markers), whose nodes are siblings of the
     *                markers in `parent`, not a separate child list.
     */
    constructor(parent: Node, nodes?: ChildNode[])
    {
        this.parent = parent;
        this.#nodes = nodes ?? Array.from(parent.childNodes);
    }

    /**
     * Returns the next unclaimed node without advancing.
     *
     * @returns The next node, or null at the end.
     */
    public peek(): ChildNode | null
    {
        return this.#nodes[this.#index] ?? null;
    }

    /**
     * Returns the next unclaimed node if it is an element, without advancing.
     *
     * @returns The element, or null if the next node is not an element.
     */
    public peekElement(): HTMLElement | null
    {
        const node = this.peek();
        return node !== null && node.nodeType === 1 ? node as HTMLElement : null;
    }

    /**
     * Claims the next node, which must be an element (optionally of `expectedTag`).
     *
     * @param expectedTag - If given, the element's tag must match (case-insensitive).
     * @returns The claimed element.
     * @throws {@link HydrationMismatchError} if the next node is not the expected element.
     */
    public takeElement(expectedTag?: string): HTMLElement
    {
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
     * Claims the next node, which must be a text node.
     *
     * @returns The claimed text node.
     * @throws {@link HydrationMismatchError} if the next node is not text.
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
     * Claims the opening reactive-hole anchor (comment `<!--[-->`).
     *
     * @throws {@link HydrationMismatchError} if the next node is not the open anchor.
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
     * Claims everything up to and including the closing reactive-hole anchor
     * (`<!--]-->`).
     *
     * @returns The content nodes between the anchors, plus the close anchor.
     * @throws {@link HydrationMismatchError} if no close anchor is found.
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
     * Claims a control-flow OPEN anchor (`<!--azc:type-->`), returned as the live start
     * marker the component reuses for later swaps.
     *
     * @returns The open-anchor comment node.
     * @throws {@link HydrationMismatchError} if the next node is not a control-flow open anchor.
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
     * Claims everything up to (not including) the BALANCED control-flow close anchor
     * (`<!--/azc-->`), then consumes that close. Balanced means nested control-flow
     * ranges are skipped: each `azc:*` raises depth, each `/azc` lowers it, so the close
     * returned matches the open already claimed by {@link takeCoOpen}. Reactive-hole
     * anchors (`[`/`]`) use a different sigil and count as ordinary content.
     *
     * @returns The content nodes between the markers, plus the matching close marker.
     * @throws {@link HydrationMismatchError} if no matching close anchor is found.
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
     * Asserts every node in this cursor's range has been claimed. A leftover node means
     * the server rendered MORE than the client expects - a mismatch the take* methods
     * cannot catch (they only detect a missing or wrong node, never an extra one).
     *
     * @param context - A short label for the mismatch message (e.g. `<div>`).
     * @throws {@link HydrationMismatchError} if any node remains unclaimed.
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

/**
 * A short human-readable label for a node, used in mismatch messages.
 *
 * @internal
 * @param node - The node to describe (or null/undefined for end-of-children).
 * @returns A label like `<div>`, `text node`, or `comment "[..]"`.
 */
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
