/**
 * MODULE: reactivity/stream-session (internal)
 *
 * The per-render state of one STREAMING server render. It rides the render-mode frame
 * (see render-mode.ts) so every synchronous serialization window - the main pass and each
 * boundary continuation - reads its own session through one accessor; awaits happen only
 * BETWEEN windows, so the module-global frame stack stays sound under concurrency.
 *
 * What it tracks:
 *   - eager server fetches started by createResource inside the session, keyed by the
 *     resource object, each with a stable SCOPED-ORDINAL id (`scope:ordinal`) the client
 *     re-derives during hydration to seed the same resource without refetching;
 *   - pending Suspense boundaries: id, the fetch entries gating them, and the
 *     continuation closure that serializes children once those settle;
 *   - finalization: root disposal is DEFERRED to stream completion, and finalize() also
 *     aborts every fetch no boundary consumed. Idempotent - the driver, a timeout, a
 *     client abort, and transport cancel may all race into it.
 */

/** @internal One eager server fetch a streaming render started. */
export interface ServerFetch
{
    /** Settles when the resource's signals settled (data or error applied). */
    promise: Promise<void>;
    controller: AbortController;

    /** The scoped-ordinal seed id, e.g. ':0' (root) or '7:2' (boundary 7, third resource). */
    id: string;

    /** Reads the settled outcome as a wire seed; meaningful once `promise` settled. */
    read: () => { d?: unknown; e?: string };
}

/** @internal One pending Suspense boundary awaiting its resources. */
export interface PendingBoundary
{
    id: number;
    entries: ServerFetch[];

    /** Serializes the children under the captured owner/scopes; runs in a continuation window. */
    render: () => string;
}

/** @internal The per-render state of one streaming SSR session. */
export class StreamSession
{
    /** The AbortSignal the whole render is tied to (client disconnect), if any. */
    public readonly signal: AbortSignal | undefined;

    /** The store scope captured inside the main pass; continuations re-enter it. */
    public storeScope: object | null = null;

    #nextBoundaryId = 0;

    readonly #scopeStack: string[] = [''];

    readonly #ordinals = new Map<string, number>();

    readonly #fetches = new Map<object, ServerFetch>();

    #boundaries: PendingBoundary[] = [];

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
