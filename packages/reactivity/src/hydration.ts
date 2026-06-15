// Hydration adopts the existing server-rendered DOM rather than recreating it.
// The challenge: h() evaluates its children inside-out (the inner h() runs
// before the outer one), so a child can't claim its server node top-down while
// it's being built. The fix: in 'hydrate' mode, h() and the control-flow
// components return a lightweight hydration descriptor instead of building DOM.
// Once the whole tree of descriptors exists, hydrate() walks it top-down
// against the server DOM (via a HydrationCursor), claiming each existing node
// and wiring listeners and effects onto it.
//
// These are the DOM-free primitives shared by the renderer (h, control-flow)
// and the component package (ErrorBoundary). The element-specific adoption
// logic (applyProps, reactive-hole text patching) lives in the renderer.

/**
 * A hydration descriptor. Returned by h()/control-flow components while the
 * `'hydrate'` render mode is active (cast to HTMLElement so it composes like a
 * real element would). Its {@link hydrate} method adopts the matching
 * server-rendered node(s) from the given cursor.
 */
export interface HydrationNode
{
    readonly __hydrate: true;

    /** Adopts this node's DOM from `cursor`, advancing it past the consumed nodes. */
    hydrate(cursor: HydrationCursor): void;
}

/**
 * Whether `x` is a {@link HydrationNode} descriptor.
 *
 * @param x - Any value
 * @returns `true` if `x` is a hydration descriptor
 *
 * @example
 * ```ts
 * isHydrationNode(hydrationNode(() => {})); // true
 * isHydrationNode('text');                  // false
 * ```
 */
export function isHydrationNode(x: unknown): x is HydrationNode
{
    return typeof x === 'object' && x !== null && (x as { __hydrate?: unknown }).__hydrate === true;
}

/**
 * Creates a {@link HydrationNode} from an adoption function.
 *
 * @param hydrate - The adoption routine
 * @returns A hydration descriptor
 *
 * @example
 * ```ts
 * const node = hydrationNode((cursor) =>
 * {
 *     const el = cursor.takeElement('div'); // claim the server <div>
 *     el.addEventListener('click', onClick);
 * });
 * node.hydrate(new HydrationCursor(container));
 * ```
 */
export function hydrationNode(hydrate: (cursor: HydrationCursor) => void): HydrationNode
{
    return { __hydrate: true, hydrate };
}

/**
 * Thrown when the server-rendered DOM doesn't structurally match what the
 * client tree expects (wrong tag, missing node, absent marker). hydrate()
 * catches this and falls back to a full client render so the app always boots.
 *
 * @example
 * ```ts
 * try
 * {
 *     cursor.takeElement('div'); // server had a <span> here
 * }
 * catch (err)
 * {
 *     if (err instanceof HydrationMismatchError) fullClientRender();
 * }
 * ```
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
 * Copies symbol-keyed properties (e.g. the destroy hooks the component package
 * attaches) from a descriptor onto the real element it was adopted into, so
 * destroyComponent() finds them on the live node after hydration.
 *
 * @param from - The descriptor that carried the symbols
 * @param to - The adopted real element
 *
 * @example
 * ```ts
 * const descriptor = {};
 * (descriptor as Record<symbol, unknown>)[DESTROY] = () => cleanup();
 * transferCarriedSymbols(descriptor, adoptedEl);
 * // adoptedEl[DESTROY] is now the cleanup hook
 * ```
 */
export function transferCarriedSymbols(from: object, to: object): void
{
    for (const sym of Object.getOwnPropertySymbols(from))
    {
        (to as Record<symbol, unknown>)[sym] = (from as Record<symbol, unknown>)[sym];
    }
}

/**
 * A read cursor over a parent node's children, used to adopt server-rendered
 * DOM in source order. Takes a snapshot of `childNodes` at construction so
 * later DOM mutations (a control-flow swap, anchor removal) don't shift it.
 *
 * @example
 * ```ts
 * // <div id="root"><p>hi</p>text</div>
 * const cursor = new HydrationCursor(document.getElementById('root')!);
 * cursor.takeElement('p'); // claims <p>, advances past it
 * cursor.takeText();       // claims the trailing "text" node
 * ```
 */
export class HydrationCursor
{
    /** The parent node whose children are being adopted. */
    public readonly parent: Node;

    /**
     * Snapshot of the parent's children at construction time.
     *
     * @internal
     */
    private readonly nodes: ChildNode[];

    /**
     * Index of the next unclaimed child.
     *
     * @internal
     */
    private index: number = 0;

    /**
     * @param parent - The node whose children are being adopted (used for live
     *                 DOM ops during hydration, e.g. patching a reactive hole).
     * @param nodes - An explicit node list to walk instead of `parent`'s live
     *                children. Used to hydrate a control-flow component's
     *                content - the slice between its comment markers - whose
     *                nodes are siblings of the markers in `parent`, not a
     *                separate child list.
     */
    constructor(parent: Node, nodes?: ChildNode[])
    {
        this.parent = parent;
        this.nodes = nodes ?? Array.from(parent.childNodes);
    }

    /**
     * Returns the next unclaimed node without advancing, or `null` at the end.
     *
     * @example
     * ```ts
     * const next = cursor.peek(); // inspect without claiming
     * if (next?.nodeType === 8) cursor.takeOpenAnchor();
     * ```
     */
    public peek(): ChildNode | null
    {
        return this.nodes[this.index] ?? null;
    }

    /**
     * Returns the next unclaimed node if it is an element (without advancing),
     * else `null`.
     *
     * @example
     * ```ts
     * if (cursor.peekElement()) cursor.takeElement(); // only claim if present
     * ```
     */
    public peekElement(): HTMLElement | null
    {
        const node = this.peek();
        return node !== null && node.nodeType === 1 ? node as HTMLElement : null;
    }

    /**
     * Claims the next node, which must be an element (optionally of `expectedTag`).
     *
     * @param expectedTag - If given, the element's tag must match (case-insensitive)
     * @returns The claimed element
     * @throws {@link HydrationMismatchError} if the next node isn't the expected element
     *
     * @example
     * ```ts
     * const button = cursor.takeElement('button'); // claims and returns <button>
     * button.addEventListener('click', onClick);
     * ```
     */
    public takeElement(expectedTag?: string): HTMLElement
    {
        const node = this.nodes[this.index];

        if (!node || node.nodeType !== 1)
        {
            throw new HydrationMismatchError(`expected <${ expectedTag ?? 'element' }>, found ${ describe(node) }`);
        }

        const el = node as HTMLElement;

        if (expectedTag !== undefined && el.tagName.toLowerCase() !== expectedTag.toLowerCase())
        {
            throw new HydrationMismatchError(`expected <${ expectedTag }>, found <${ el.tagName.toLowerCase() }>`);
        }

        this.index++;
        return el;
    }

    /**
     * Claims the next node, which must be a text node.
     *
     * @returns The claimed text node
     * @throws {@link HydrationMismatchError} if the next node isn't text
     *
     * @example
     * ```ts
     * const text = cursor.takeText(); // claims the next text node
     * text.data; // its current server-rendered string
     * ```
     */
    public takeText(): Text
    {
        const node = this.nodes[this.index];

        if (!node || node.nodeType !== 3)
        {
            throw new HydrationMismatchError(`expected text node, found ${ describe(node) }`);
        }

        this.index++;
        return node as Text;
    }

    /**
     * Claims the opening reactive-hole anchor (`<!--[-->`).
     *
     * @throws {@link HydrationMismatchError} if the next node isn't the open anchor
     *
     * @example
     * ```ts
     * // For <!--[-->42<!--]--> emitted around a reactive hole:
     * cursor.takeOpenAnchor();              // consume the <!--[--> anchor
     * const { content } = cursor.takeUntilCloseAnchor(); // the [42] text nodes
     * ```
     */
    public takeOpenAnchor(): void
    {
        const node = this.nodes[this.index];

        if (!node || node.nodeType !== 8 || (node as Comment).data !== '[')
        {
            throw new HydrationMismatchError(`expected reactive-hole open anchor, found ${ describe(node) }`);
        }

        this.index++;
    }

    /**
     * Claims everything up to and including the closing reactive-hole anchor
     * (`<!--]-->`).
     *
     * @returns The content nodes between the anchors and the close anchor itself
     * @throws {@link HydrationMismatchError} if no close anchor is found
     *
     * @example
     * ```ts
     * cursor.takeOpenAnchor();
     * const { content, closeAnchor } = cursor.takeUntilCloseAnchor();
     * content;     // the nodes that filled the reactive hole
     * closeAnchor; // the <!--]--> comment, now consumed
     * ```
     */
    public takeUntilCloseAnchor(): { content: ChildNode[]; closeAnchor: Comment }
    {
        const content: ChildNode[] = [];

        while (this.index < this.nodes.length)
        {
            const node = this.nodes[this.index];

            if (node.nodeType === 8 && (node as Comment).data === ']')
            {
                this.index++;
                return { content, closeAnchor: node as Comment };
            }

            content.push(node);
            this.index++;
        }

        throw new HydrationMismatchError('unterminated reactive-hole anchor');
    }

    /**
     * Claims a control-flow OPEN anchor (`<!--azc:type-->`), returning it as
     * the live start marker the component reuses for later swaps.
     *
     * @returns The open-anchor comment node
     * @throws {@link HydrationMismatchError} if the next node isn't a control-flow open anchor
     *
     * @example
     * ```ts
     * // For <!--azc:show--><p>hi</p><!--/azc--> emitted by wrapContentsAnchored:
     * const start = cursor.takeCoOpen();              // the <!--azc:show--> marker
     * const { content, end } = cursor.takeCoBalanced(); // [<p>hi</p>], the <!--/azc--> marker
     * ```
     */
    public takeCoOpen(): Comment
    {
        const node = this.nodes[this.index];

        if (!node || node.nodeType !== 8 || !(node as Comment).data.startsWith('azc:'))
        {
            throw new HydrationMismatchError(`expected control-flow open anchor, found ${ describe(node) }`);
        }

        this.index++;
        return node as Comment;
    }

    /**
     * Claims everything up to (but NOT including) the BALANCED control-flow
     * close anchor (`<!--/azc-->`), then consumes that close anchor. Balanced
     * means nested control-flow ranges inside the content are skipped over: each
     * `<!--azc:*-->` seen raises the depth and each `<!--/azc-->` lowers it, so
     * the close returned is the one that matches the open already claimed by
     * {@link takeCoOpen} - never an inner range's close. Reactive-hole anchors
     * (`[` / `]`) use a different sigil and are treated as ordinary content.
     *
     * @returns The content nodes between the markers and the close marker itself
     * @throws {@link HydrationMismatchError} if no matching close anchor is found
     */
    public takeCoBalanced(): { content: ChildNode[]; end: Comment }
    {
        const content: ChildNode[] = [];
        let depth = 0;

        while (this.index < this.nodes.length)
        {
            const node = this.nodes[this.index];

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
                        this.index++;
                        return { content, end: node as Comment };
                    }
                    depth--;
                }
            }

            content.push(node);
            this.index++;
        }

        throw new HydrationMismatchError('unterminated control-flow anchor');
    }
}

/**
 * A short human-readable label for a node, used in mismatch messages.
 *
 * @internal
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
