/**
 * The per-render state of one streaming server render.
 *
 * It rides the render-mode frame, so every synchronous serialization window - the main pass
 * and each boundary continuation - reads its own session through a single accessor. Awaits
 * happen only BETWEEN windows, which is what keeps the module-global frame stack sound
 * under concurrency.
 *
 * It tracks the eager server fetches createResource started inside the session, keyed by
 * resource and each carrying the scoped-ordinal id the client re-derives at hydration to
 * seed the same resource without refetching; the pending Suspense boundaries, with the
 * fetches gating them and the continuation that serializes their children; and
 * finalization, which defers root disposal to stream completion and aborts every fetch no
 * boundary consumed.
 *
 * finalize() is idempotent because the driver, a timeout, a client abort and a transport
 * cancel may all race into it.
 */

/** One eager server fetch a streaming render started. */
export interface ServerFetch
{
    /** Settles when the resource's signals settled (data or error applied). */
    promise: Promise<void>;
    controller: AbortController;

    /** The scoped-ordinal seed id: `':0'` at the root, `'7:2'` for boundary 7's third resource. */
    id: string;

    /** The settled outcome as a wire seed. Only meaningful once `promise` has settled. */
    read: () => { d?: unknown; e?: string };
}

/** One pending Suspense boundary awaiting its resources. */
export interface PendingBoundary
{
    id: number;
    entries: ServerFetch[];

    /** Serializes the children under the captured owner and scopes, in a continuation window. */
    render: () => string;

    /**
     * The value of the nearest enclosing `<select>`, when this boundary's content sits inside
     * one.
     *
     * A select serializes its children BEFORE it can know they contain a pending boundary's
     * fallback, and the real options arrive later in a continuation chunk. Recording the value
     * here is what lets that chunk mark the right option. Without it the swapped-in options
     * carry no `selected`, and a page whose chunk lands before hydration paints the browser's
     * default until the client repairs it.
     */
    select?: { desired: string | readonly string[]; multiple: boolean };
}

/** The per-render state of one streaming SSR session. */
export class StreamSession
{
    /** The signal the whole render is tied to, typically a client disconnect. */
    public readonly signal: AbortSignal | undefined;

    /** The store scope captured inside the main pass; continuations re-enter it. */
    public storeScope: object | null = null;

    #nextBoundaryId = 0;

    readonly #scopeStack: string[] = [''];

    readonly #ordinals = new Map<string, number>();

    readonly #fetches = new Map<object, ServerFetch>();

    #boundaries: PendingBoundary[] = [];

    /** Every boundary by id, INCLUDING drained ones - takeBoundaries empties the queue above. */
    readonly #boundariesById = new Map<number, PendingBoundary>();

    readonly #finalizers: Array<() => void> = [];

    #finalized = false;

    constructor(signal?: AbortSignal)
    {
        this.signal = signal;
    }

    public allocateBoundaryId(): number
    {
        return this.#nextBoundaryId++;
    }

    /** Runs `fn` with `scope` as the active resource-ordinal scope. */
    public inScope<T>(scope: string, fn: () => T): T
    {
        this.#scopeStack.push(scope);
        try
        {
            return fn();
        }
        finally
        {
            this.#scopeStack.pop();
        }
    }

    /** The next seed id in the active scope - the client counts identically at hydrate. */
    public allocateResourceId(): string
    {
        const scope = this.#scopeStack[this.#scopeStack.length - 1] ?? '';
        const ordinal = this.#ordinals.get(scope) ?? 0;
        this.#ordinals.set(scope, ordinal + 1);
        return `${ scope }:${ ordinal }`;
    }

    public registerFetch(resource: object, entry: ServerFetch): void
    {
        this.#fetches.set(resource, entry);
    }

    public fetchOf(resource: object): ServerFetch | undefined
    {
        return this.#fetches.get(resource);
    }

    public registerBoundary(boundary: PendingBoundary): void
    {
        this.#boundaries.push(boundary);
        this.#boundariesById.set(boundary.id, boundary);
    }

    /** A boundary by id, whether or not the driver has taken it yet. */
    public boundaryOf(id: number): PendingBoundary | undefined
    {
        return this.#boundariesById.get(id);
    }

    /** Drains the boundaries registered since the last take (the driver consumes these). */
    public takeBoundaries(): PendingBoundary[]
    {
        const taken = this.#boundaries;
        this.#boundaries = [];
        return taken;
    }

    public onFinalize(fn: () => void): void
    {
        if (this.#finalized)
        {
            fn();
            return;
        }
        this.#finalizers.push(fn);
    }

    public get finalized(): boolean
    {
        return this.#finalized;
    }

    /** Tears the session down: root disposal, then every unconsumed fetch aborts. Idempotent. */
    public finalize(): void
    {
        if (this.#finalized)
        {
            return;
        }
        this.#finalized = true;
        for (const fn of this.#finalizers)
        {
            try
            {
                fn();
            }
            catch
            {
                // A finalizer must never stop the others; the render is already over.
            }
        }
        for (const entry of this.#fetches.values())
        {
            entry.controller.abort();
        }
    }
}
