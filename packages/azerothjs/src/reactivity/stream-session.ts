/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The per-render state of one streaming server render.
 *
 * It rides the render-mode frame, so every synchronous serialization window - the main pass
 * and each boundary continuation - reads its own session through a single accessor. Awaits
 * happen only BETWEEN windows, which is what keeps the module-global frame stack sound
 * under concurrency.
 *
 * It tracks the eager server fetches createResource started inside the session, keyed by
 * resource, and the Suspense boundaries that list them. Each boundary supplies the document
 * id and watch-list indexes that identify its seeds at hydration. The session also owns
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

    /** A diagnostic name when available in a development build. */
    name?: string | undefined;

    /** The settled outcome as a wire seed. Only meaningful once `promise` has settled. */
    read: () => { d?: unknown; e?: string };
}

/** A boundary's full watch list, with empty positions for resources the server did not fetch. */
export interface BoundarySeeds
{
    id: number;
    entries: Array<ServerFetch | undefined>;
}

/** One pending Suspense boundary awaiting its resources. */
export interface PendingBoundary extends BoundarySeeds
{
    /** Serializes the children under the captured owner, in a continuation window. */
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

    #inlineSeeds: BoundarySeeds[] = [];

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

    /** An already-settled boundary's content and seeds travel with the enclosing chunk. */
    public registerInlineSeeds(boundary: BoundarySeeds): void
    {
        this.#inlineSeeds.push(boundary);
    }

    /** Drains the inline boundaries produced by this synchronous continuation. */
    public takeInlineSeeds(): BoundarySeeds[]
    {
        const taken = this.#inlineSeeds;
        this.#inlineSeeds = [];
        return taken;
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
