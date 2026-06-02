// ============================================================================
// AZEROTHJS — Hydration Primitives (Descriptor + DOM Cursor)
// ============================================================================
//
// AzerothJS hydration adopts the EXISTING server-rendered DOM rather than
// recreating it. The challenge: h() evaluates its children inside-out (the
// inner h() runs before the outer one), so a child can't claim its server
// node "top-down" while it's being built. The fix: in 'hydrate' mode, h()
// and the control-flow components return a lightweight HYDRATION DESCRIPTOR
// instead of building DOM. After the whole tree of descriptors is returned,
// hydrate() walks it TOP-DOWN against the server DOM (via a HydrationCursor),
// claiming each existing node and wiring listeners/effects onto it.
//
// These are the DOM-free primitives shared by the renderer (h + control-flow)
// and the component package (ErrorBoundary). The element-specific adoption
// logic (applyProps, reactive-hole text patching) lives in the renderer.
//
// ============================================================================

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
 */
export function hydrationNode(hydrate: (cursor: HydrationCursor) => void): HydrationNode
{
    return { __hydrate: true, hydrate };
}

/**
 * Thrown when the server-rendered DOM doesn't structurally match what the
 * client tree expects (wrong tag, missing node, absent marker). hydrate()
 * catches this and falls back to a full client render so the app always boots.
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

    constructor(parent: Node)
    {
        this.parent = parent;
        this.nodes = Array.from(parent.childNodes);
    }

    /**
     * Returns the next unclaimed node without advancing, or `null` at the end.
     */
    public peek(): ChildNode | null
    {
        return this.nodes[this.index] ?? null;
    }

    /**
     * Returns the next unclaimed node if it is an element (without advancing),
     * else `null`.
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
