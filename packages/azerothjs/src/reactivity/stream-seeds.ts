/**
 * MODULE: reactivity/stream-seeds (internal)
 *
 * The hydrate-side counterpart of the streaming session's resource seeds. A streamed page's
 * swap chunks merged every boundary's resolved data into `globalThis.__AZS_S`, keyed by
 * SCOPED ORDINALS (`scope:ordinal`) - and this module re-derives the same ids during
 * hydration: the scope stack is pushed by Suspense around its children (the boundary id
 * from the adopted marker), and the ordinal ticks per createResource call. A seed hit
 * seeds the resource settled (no refetch); a miss means normal behavior. Zero-cost on
 * non-streamed pages: the global is absent and every lookup answers undefined.
 */

/** @internal One streamed resource outcome: resolved data or a (lossy, stringified) error. */
export interface StreamSeed
{
    d?: unknown;
    e?: string;
}

/** @internal The scope stack; root scope is ''. Mirrors StreamSession#scopeStack. */
const scopes: string[] = [''];

/** @internal Per-scope ordinal counters. Mirrors StreamSession#ordinals. */
const ordinals = new Map<string, number>();

/** @internal Pushes a boundary's seed scope around its children's construction. */
export function pushSeedScope(scope: string): void
{
    scopes.push(scope);
}

/** @internal Pops the boundary's seed scope. */
export function popSeedScope(): void
{
    scopes.pop();
}

/**
 * @internal The next seed id in the active scope. Ticks unconditionally in hydrate mode -
 * counting must stay aligned with the server whether or not a given resource was seeded.
 */
export function allocateSeedId(): string
{
    const scope = scopes[scopes.length - 1] ?? '';
    const ordinal = ordinals.get(scope) ?? 0;
    ordinals.set(scope, ordinal + 1);
    return `${ scope }:${ ordinal }`;
}

/**
 * @internal Takes (reads and removes) the seed for `id`, or undefined when the page was
 * not streamed or the id has no entry - the degradation is a plain client fetch.
 */
export function takeStreamSeed(id: string): StreamSeed | undefined
{
    const store = (globalThis as { __AZS_S?: Record<string, StreamSeed> }).__AZS_S;
    if (store === undefined)
    {
        return undefined;
    }
    const seed = store[id];
    if (seed !== undefined)
    {
        // Consumed once: a later client-side re-creation of "the same" resource is a new
        // fetch, not a stale seed. The ids are framework-minted ordinals, never input.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- see above
        delete store[id];
    }
    return seed;
}

/** @internal Test seam: resets the hydrate-side counters between hydrations. */
export function resetSeedScopes(): void
{
    scopes.length = 0;
    scopes.push('');
    ordinals.clear();
}
