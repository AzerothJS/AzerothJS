/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The app-level data cache: one registry per store scope, shared by keyed resources, route
 * loaders and prefetch, and invalidated by `revalidate`.
 *
 * A `cached(name, fetcher)` family names a key space; an entry is one argument set's state.
 * Entries own every fetch: instances subscribe and mirror, so two readers of one key share
 * one request, a revalidation reaches every subscriber through the entry's version signal,
 * and an unwatched entry is never fetched on anyone's behalf.
 *
 * Ownership is the store scope. The client's default scope makes the cache app-wide; a
 * server render or request scope makes it die with its owner. On a server the default scope
 * is process-lifetime, so once any server entry point has run, reads resolving there bypass
 * the cache entirely rather than share entries across requests.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createStore } from './create-store.ts';
import { getStoreScope, isDefaultScope } from './store-scope.ts';
import { getRenderMode, isStringMode } from './render-mode.ts';
import { untrack } from './untrack.ts';
import { DEV } from './dev.ts';

/** Brands a fetcher wrapped by {@link cached}; createResource dispatches on its presence. */
export const CACHED_FAMILY: unique symbol = Symbol('azeroth.cached');

/** Options for {@link cached}. */
export interface CachedOptions
{
    /**
     * How long, in milliseconds, a retained value satisfies a NEW subscription without a
     * background revalidation. `0` (the default) revalidates on every re-subscription;
     * `Infinity` never does. Entries with live subscribers are fresh regardless.
     */
    fresh?: number;

    /**
     * How long, in milliseconds, an unsubscribed entry is retained before eviction. This
     * is also the staleness bound for entries a DEV hot-swap cannot reach: scope-owned
     * caches (requests, renders) are not walked on re-registration, so their unheld
     * entries serve the old code until this window expires - a large retain stretches
     * that accordingly.
     */
    retain?: number;
}

/** The per-family record every entry of one key space shares. */
export interface FamilyRecord
{
    name: string;
    fetcher: (...args: unknown[]) => Promise<unknown>;
    fresh: number;
    retain: number;
}

/** A fetcher wrapped by {@link cached}: callable as a plain fetcher, targetable by revalidate. */
export interface CachedFetcher<A extends unknown[], T>
{
    (...args: [...A, AbortSignal?]): Promise<T>;
    readonly [CACHED_FAMILY]: FamilyRecord;
}

/**
 * A fetcher may declare its trailing AbortSignal or ignore it; the family's argument list
 * is the parameters WITHOUT that signal either way.
 */
type DropTrailingSignal<P extends unknown[]> = P extends [...infer Rest, AbortSignal] ? Rest : P;

const DEFAULT_RETAIN_MS = 5 * 60 * 1000;

/** One key's state. Fetches belong to the entry, never to a subscriber. */
/**
 * One in-flight optimistic guess over an entry's value.
 *
 * A guess belongs on the ENTRY rather than beside one resource, because every reader of the
 * family is showing the same number: a cart badge in the header and the cart page itself must
 * move together, and a guess held in one component's scope moves only that component.
 *
 * Layers are a STACK, applied oldest-first on read. Two mutations in flight are two layers, so
 * neither has to know about the other, and a failure removes exactly its own - the projection
 * is recomputed from the base on every read, so nothing needs repairing.
 */
export interface OptimisticLayer
{
    id: number;

    /** Pure: receives the value below it in the stack and returns the guessed one. */
    project: (value: unknown) => unknown;

    /** True once its mutation succeeded; a settled layer folds into the base at the bottom. */
    settled: boolean;
}

export interface CacheEntry
{
    key: string;
    value: unknown;
    hasValue: boolean;
    hasError: boolean;
    error: unknown;
    version: Getter<number>;
    bumpVersion: () => void;
    bumpScheduled: boolean;
    generation: number;
    markSeq: number;
    inflight: { controller: AbortController; generation: number; startedSeq: number } | null;
    /** Waiters for a settle whose startedSeq >= minSeq; resolved on settle, eviction or reset. */
    settleWaiters: { minSeq: number; resolve: () => void }[];
    stale: boolean;
    writtenAt: number;
    subscribers: number;
    waiters: number;
    retainTimer: ReturnType<typeof setTimeout> | null;
    zeroCheckScheduled: boolean;
    args: unknown[];

    /** Optimistic guesses over {@link value}, oldest first. Empty for all but a mutating entry. */
    layers: OptimisticLayer[];
    parentKey: string | null;
    usedParent: boolean;
    family: FamilyRecord;

    /** The producing deployment's build id, recorded at seed adoption for deploy-aware use. */
    build?: string;

    /** The seed's produce time, when adopted from a handoff. */
    seededAt?: number;

    /**
     * Until when a PREFETCHED value may be served to its first subscriber without refetching.
     *
     * A zero-subscriber entry is normally refetched the moment something subscribes, which is
     * right when nobody asked for its value - but a prefetch is somebody asking, just early.
     * Without this hold every prefetch would be thrown away by the very navigation it was meant
     * to make instant, and would look like it worked.
     *
     * Consumed by that first subscriber, so a hold can serve once and never twice.
     */
    warmUntil?: number;
}

/** Distinguishes every optimistic layer this process creates. */
let layerSerial = 0;

/**
 * The value a reader sees: the entry's own value with every optimistic guess applied, oldest
 * first. Computed on READ rather than stored, so removing a failed guess needs no repair - the
 * remaining layers simply project the base again.
 */
export function projectedValue(entry: CacheEntry): unknown
{
    let value = entry.value;
    for (const layer of entry.layers)
    {
        value = layer.project(value);
    }
    return value;
}

let serverLatched = false;
let serverRuntime = false;

/** Scopes whose host already tore down; membership dies with the scope object. */
const releasedScopes = new WeakSet<object>();

let disabledServerWarned = false;
let disabledBrowserWarned = false;
let buildContext = false;

/**
 * DEV-only: family name -> shared record, WEAKLY, so an HMR re-registration swaps in
 * place without the map itself retaining anything: a module-held family stays alive
 * through its fetcher (which carries the record), while a DYNAMIC name (a per-tenant or
 * per-request `cached()`) whose fetcher and entries died becomes collectible instead of
 * pinning its closure forever - the map was the one add-only holder. The reaper prunes
 * the dead name, re-checking liveness first: the name may have been re-registered with a
 * fresh record between collection and callback.
 */
const devFamilies: Map<string, WeakRef<FamilyRecord>> | null = DEV ? new Map() : null;
const devFamilyReaper: FinalizationRegistry<string> | null = DEV
    ? new FinalizationRegistry((name) =>
    {
        if (devFamilies?.get(name)?.deref() === undefined)
        {
            devFamilies?.delete(name);
        }
    })
    : null;

/** DEV-only: live client caches, reachable for HMR-driven family invalidation. */
const devClientCaches: Set<DataCache> | null = DEV ? new Set() : null;

/**
 * Keys whose fetcher is in its SYNCHRONOUS invocation window. A revalidate targeting a
 * key from inside its own fetcher must be a no-op in EVERY mode - awaiting deadlocks and
 * even marking loops (the follow-up re-marks itself) - so the tracking is unconditional;
 * only the diagnostic is DEV-gated.
 */
const executingKeys = new Set<string>();

/**
 * Serializes a key part deterministically: object keys sorted, array order significant.
 *
 * A cache key must be INJECTIVE, so a value this cannot distinguish is refused rather than
 * approximated - in production as well as development. Degrading to `String(value)` returned the
 * constant "[object Object]" for every class instance, collapsing distinct callers onto one entry
 * and serving them each other's data, and it did so only in production where nothing is watching.
 */
export function stableSerialize(value: unknown): string
{
    const kind = typeof value;
    if (value === null || kind === 'number' || kind === 'boolean' || kind === 'string')
    {
        return JSON.stringify(value);
    }
    if (value === undefined)
    {
        return 'undefined';
    }
    if (typeof value === 'bigint')
    {
        // Distinct bigints stringify distinctly, so this is a faithful key. Tagged so 1n and
        // "1" cannot share an entry.
        return `${ String(value) }n`;
    }
    if (Array.isArray(value))
    {
        return `[${ value.map(stableSerialize).join(',') }]`;
    }
    if (kind === 'object')
    {
        // JSON's own contract first: a Date, a URL, or any class carrying toJSON keys on
        // its serialized form - the walker must never be LESS faithful than JSON.stringify.
        const withToJson = value as { toJSON?: () => unknown };
        if (typeof withToJson.toJSON === 'function')
        {
            return stableSerialize(withToJson.toJSON());
        }
        // A Map, Set, or class instance without toJSON has no enumerable identity: walking
        // its own keys would collapse distinct values into ONE entry and serve wrong data.
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null)
        {
            const name = (proto as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'unknown';
            throw new TypeError(`[azeroth] cached key parts must be plain data or carry toJSON; received an instance of ${ name }.`);
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        return `{${ keys.map(k => `${ JSON.stringify(k) }:${ stableSerialize(record[k]) }`).join(',') }}`;
    }
    throw new TypeError(`[azeroth] cached key parts must be JSON-serializable, received ${ kind }.`);
}

/** The entry key for a family and argument list. */
export function entryKeyFor(family: FamilyRecord, args: unknown[]): string
{
    return `${ family.name }|${ stableSerialize(args) }`;
}

/**
 * The scope-owned registry. All fetch starts live here; subscribers only read, mirror and
 * hold refcounts.
 */
export class DataCache
{
    readonly #entries = new Map<string, CacheEntry>();

    /** Monotonic; orders marks against fetch starts and navigations without a clock. */
    #seq = 0;

    /** The seq at the latest navigation commit; marks never target fetches begun after it. */
    #navSeq = 0;

    /** Set once by {@link release}; a released cache never holds or arms anything again. */
    #released = false;

    constructor()
    {
        // Only the APP-SCOPE cache joins the HMR registry: its lifetime is the app's, and
        // the invalidation walk is its sole consumer. A scope-owned cache (request, render,
        // future unit scopes) is owned by its host and torn down with its scope - admitting
        // it here pinned one cache per request forever on any server that never latched.
        if (DEV && isDefaultScope(getStoreScope()))
        {
            devClientCaches?.add(this);
        }
    }

    /** True once {@link release} ran: the cache holds nothing and admits nothing. */
    public get released(): boolean
    {
        return this.#released;
    }

    public nextSeq(): number
    {
        this.#seq += 1;
        return this.#seq;
    }

    public beginNavigation(): void
    {
        this.#navSeq = this.nextSeq();
    }

    public entryFor(family: FamilyRecord, args: unknown[]): CacheEntry
    {
        const key = entryKeyFor(family, args);
        if (DEV && key.length > 2048)
        {
            console.warn(`[azeroth] cached key for '${ family.name }' is ${ key.length } chars; `
                + 'adversarial or unbounded inputs in key parts grow the cache without bound.');
        }
        let entry = this.#entries.get(key);
        if (entry === undefined)
        {
            const [version, setVersion] = createSignal(0, { name: 'cache-version' });
            const created: CacheEntry = {
                key,
                value: undefined,
                hasValue: false,
                hasError: false,
                error: undefined,
                version,
                bumpVersion: () => setVersion(v => v + 1),
                bumpScheduled: false,
                generation: 0,
                markSeq: 0,
                inflight: null,
                settleWaiters: [],
                stale: false,
                writtenAt: 0,
                subscribers: 0,
                waiters: 0,
                retainTimer: null,
                zeroCheckScheduled: false,
                args,
                layers: [],
                parentKey: null,
                usedParent: false,
                family
            };
            entry = created;
            this.#entries.set(key, entry);
            // A zero-subscriber creation (prefetch warm, seed write) starts its retention
            // clock immediately; a subscriber arriving cancels it.
            this.#scheduleRetention(entry);
        }
        else
        {
            entry.args = args;
        }
        return entry;
    }

    public peek(family: FamilyRecord, args: unknown[]): CacheEntry | undefined
    {
        return this.#entries.get(entryKeyFor(family, args));
    }

    public entriesOf(family: FamilyRecord): CacheEntry[]
    {
        const prefix = `${ family.name }|`;
        const matches: CacheEntry[] = [];
        for (const entry of this.#entries.values())
        {
            if (entry.key.startsWith(prefix))
            {
                matches.push(entry);
            }
        }
        return matches;
    }

    public allEntries(): CacheEntry[]
    {
        return [...this.#entries.values()];
    }

    public subscribe(entry: CacheEntry): void
    {
        entry.subscribers += 1;
        if (entry.retainTimer !== null)
        {
            clearTimeout(entry.retainTimer);
            entry.retainTimer = null;
        }
    }

    public unsubscribe(entry: CacheEntry): void
    {
        entry.subscribers -= 1;
        this.#deferZeroCheck(entry);
    }

    public holdWaiter(entry: CacheEntry): void
    {
        entry.waiters += 1;
    }

    public releaseWaiter(entry: CacheEntry): void
    {
        entry.waiters -= 1;
        this.#deferZeroCheck(entry);
    }

    /**
     * The zero-audience consequences (abort, retention) run a microtask late, so an effect
     * re-run that releases and immediately re-acquires the same entry never kills its own
     * fetch through the transient zero.
     */
    #deferZeroCheck(entry: CacheEntry): void
    {
        if (entry.zeroCheckScheduled)
        {
            return;
        }
        entry.zeroCheckScheduled = true;
        queueMicrotask(() =>
        {
            entry.zeroCheckScheduled = false;
            if (entry.subscribers > 0 || entry.waiters > 0)
            {
                return;
            }
            if (entry.inflight !== null)
            {
                entry.inflight.controller.abort();
                entry.inflight = null;
                this.#resolveWaitersUpTo(entry, Infinity);
            }
            this.#scheduleRetention(entry);
        });
    }

    #scheduleRetention(entry: CacheEntry): void
    {
        // The #released term is load-bearing, not defensive: release() resolves waiters,
        // whose readValue continuations run as microtasks AFTER release returns and reach
        // this method through the zero-check - without the gate, a fresh retain timer would
        // re-arm on the released cache, pinning it for the retain window. Timers otherwise
        // arm for EVERY cache: an entry nobody holds dies after its retain window wherever
        // it lives, which is what makes a long-lived server scope bounded.
        if (this.#released || entry.retainTimer !== null || entry.subscribers > 0)
        {
            return;
        }
        entry.retainTimer = setTimeout(() =>
        {
            entry.retainTimer = null;
            if (entry.subscribers === 0 && entry.waiters === 0)
            {
                this.#entries.delete(entry.key);
                this.#resolveWaitersUpTo(entry, Infinity);
            }
        }, entry.family.retain);
        // A dangling timer must never hold a Node test process open.
        (entry.retainTimer as { unref?: () => void }).unref?.();
    }

    /**
     * The read machine, first matching rule wins: in-flight > error > stale > no-value >
     * value. Every fetch decision funnels through ensureFetch, so a re-entrant read can only
     * ever join.
     */
    public read(entry: CacheEntry, flags: { subscribing?: boolean; fromZero?: boolean; mandate?: boolean } = {}): void
    {
        if (entry.inflight !== null)
        {
            return;
        }
        if (entry.hasError)
        {
            if (flags.subscribing === true || flags.mandate === true)
            {
                this.ensureFetch(entry);
            }
            return;
        }
        if (entry.stale)
        {
            if (entry.subscribers > 0)
            {
                this.ensureFetch(entry);
            }
            return;
        }
        if (!entry.hasValue)
        {
            this.ensureFetch(entry);
            return;
        }
        if (flags.subscribing === true && flags.fromZero === true)
        {
            const warm = entry.warmUntil !== undefined && Date.now() < entry.warmUntil;
            delete entry.warmUntil;
            const age = Date.now() - entry.writtenAt;
            if (!warm && !(age < entry.family.fresh))
            {
                this.ensureFetch(entry);
            }
        }
    }

    /**
     * Holds a prefetched value for its first subscriber, so the navigation a prefetch predicted
     * reads it instead of fetching it again. `until` bounds how long that claim is worth
     * anything: past it the entry is an ordinary unheld value and the usual rule applies.
     */
    public holdWarm(entry: CacheEntry, until: number): void
    {
        entry.warmUntil = until;
    }

    public ensureFetch(entry: CacheEntry): void
    {
        if (entry.inflight !== null)
        {
            return;
        }
        this.#startFetch(entry);
    }

    /** Bypasses freshness: aborts any in-flight fetch and starts over. */
    public force(entry: CacheEntry): Promise<void>
    {
        if (entry.inflight !== null)
        {
            entry.inflight.controller.abort();
            entry.inflight = null;
        }
        this.#startFetch(entry);
        const started = entry.inflight as CacheEntry['inflight'];
        return this.settlementFor(entry, started === null ? 0 : started.startedSeq);
    }

    /** Resolves at the first settle whose startedSeq >= minSeq, or at eviction/reset. */
    public settlementFor(entry: CacheEntry, minSeq: number): Promise<void>
    {
        if (entry.inflight === null && entry.markSeq < minSeq)
        {
            return Promise.resolve();
        }
        return new Promise((resolve) =>
        {
            entry.settleWaiters.push({ minSeq, resolve });
        });
    }

    #resolveWaitersUpTo(entry: CacheEntry, settledSeq: number): void
    {
        if (entry.settleWaiters.length === 0)
        {
            return;
        }
        const remaining: { minSeq: number; resolve: () => void }[] = [];
        for (const waiter of entry.settleWaiters)
        {
            if (settledSeq >= waiter.minSeq)
            {
                waiter.resolve();
            }
            else
            {
                remaining.push(waiter);
            }
        }
        entry.settleWaiters = remaining;
    }

    #startFetch(entry: CacheEntry): void
    {
        entry.generation += 1;
        const generation = entry.generation;
        const controller = new AbortController();
        const startedSeq = this.nextSeq();
        entry.inflight = { controller, generation, startedSeq };
        this.#scheduleBump(entry);

        let pending: Promise<unknown>;
        executingKeys.add(entry.key);
        try
        {
            const fetcher = entry.family.fetcher;
            pending = Promise.resolve(fetcher(...entry.args, controller.signal));
        }
        catch (thrown)
        {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the fetcher's thrown value propagates verbatim
            pending = Promise.reject(thrown);
        }
        finally
        {
            executingKeys.delete(entry.key);
        }

        pending.then(
            (result) =>
            {
                this.#settle(entry, generation, startedSeq, { value: result });
            },
            (failure: unknown) =>
            {
                this.#settle(entry, generation, startedSeq, { error: failure });
            }
        );
    }

    #settle(entry: CacheEntry, generation: number, startedSeq: number, outcome: { value?: unknown; error?: unknown }): void
    {
        // A superseded fetch writes nothing; its waiters are the surviving fetch's problem.
        if (entry.generation !== generation || entry.inflight === null || entry.inflight.generation !== generation)
        {
            return;
        }
        entry.inflight = null;
        if ('value' in outcome)
        {
            entry.value = outcome.value;
            entry.hasValue = true;
            entry.hasError = false;
            entry.error = undefined;
            entry.writtenAt = Date.now();
            if (startedSeq >= entry.markSeq)
            {
                entry.stale = false;
            }
        }
        else
        {
            entry.hasError = true;
            entry.error = outcome.error;
        }
        entry.bumpVersion();
        this.#resolveWaitersUpTo(entry, startedSeq);

        // The post-mark follow-up: a settle that predates the last mark owes the mark one
        // fetch, but only an audience justifies it - at zero subscribers the mark persists.
        if (startedSeq < entry.markSeq)
        {
            if (entry.subscribers > 0)
            {
                this.ensureFetch(entry);
            }
            else
            {
                this.#resolveWaitersUpTo(entry, Infinity);
            }
        }

        // Parent renewal propagates to the children that AWAITED it: subscribed children
        // refetch (an in-flight child just joins), unsubscribed ones go stale for their
        // next reader. Trees have no cycles, so the chain terminates.
        if ('value' in outcome)
        {
            for (const child of this.#entries.values())
            {
                if (child.parentKey === entry.key && child.usedParent)
                {
                    if (child.subscribers > 0)
                    {
                        this.ensureFetch(child);
                    }
                    else
                    {
                        child.stale = true;
                    }
                }
            }
        }
    }

    /**
     * Fetch-start bumps are deferred a microtask so the reading effect that started the
     * fetch never writes the signal it tracks within its own frame; settles bump
     * synchronously from promise reactions.
     */
    #scheduleBump(entry: CacheEntry): void
    {
        if (entry.bumpScheduled)
        {
            return;
        }
        entry.bumpScheduled = true;
        queueMicrotask(() =>
        {
            entry.bumpScheduled = false;
            entry.bumpVersion();
        });
    }

    /**
     * Marks an entry stale and, with an audience, refetches. The returned promise resolves
     * at settled data for subscribed entries, and at the mark itself for unsubscribed
     * ones - nothing was watching, so nothing was triggered to await.
     */
    public revalidateEntry(entry: CacheEntry): Promise<void>
    {
        // Self-targeting from inside the key's own executing fetcher: a NO-OP in every
        // mode. Awaiting the follow-up would deadlock (it cannot start until this settle),
        // and even marking would loop - the follow-up's own body would re-mark itself
        // forever. The running fetch already delivers this entry's freshest data.
        if (executingKeys.has(entry.key))
        {
            if (DEV)
            {
                console.warn(`[azeroth] revalidate targeted '${ entry.key }' from inside its own fetcher; `
                    + 'ignored - the running fetch is already producing this entry\'s freshest data. '
                    + 'Revalidate a DIFFERENT family, or after the fetch settles.');
            }
            return Promise.resolve();
        }
        // A fetch begun after the current navigation committed cannot be stale to anyone.
        if (entry.inflight !== null && entry.inflight.startedSeq >= this.#navSeq && this.#navSeq > 0)
        {
            return Promise.resolve();
        }
        entry.markSeq = this.nextSeq();
        entry.stale = true;
        entry.bumpVersion();
        if (entry.subscribers === 0)
        {
            return Promise.resolve();
        }
        const settlement = this.settlementFor(entry, entry.markSeq);
        if (entry.inflight === null)
        {
            this.read(entry, { mandate: true });
        }
        this.holdWaiter(entry);
        return settlement.finally(() =>
        {
            this.releaseWaiter(entry);
        });
    }

    /**
     * Pushes an optimistic guess onto an entry and notifies every reader of the family.
     * Returns the layer's id, which is how its author later settles or drops exactly its own.
     */
    public patchEntry(entry: CacheEntry, project: (value: unknown) => unknown): number
    {
        const id = ++layerSerial;
        entry.layers.push({ id, project, settled: false });
        entry.bumpVersion();
        return id;
    }

    /**
     * Marks a guess CONFIRMED and folds it into the entry's value, so a later refetch failure
     * cannot revert what the server already accepted.
     *
     * Folding runs from the BOTTOM of the stack and stops at the first unsettled layer. A layer
     * projects the value below it, so promoting one out of order would apply its predecessor
     * twice; waiting is both correct and invisible, since the projection already shows the
     * guess. The fold and the removal are one SYNCHRONOUS step, and a reader only re-reads on
     * the version effect, so nobody can observe the promoted value with its own guess still on
     * top - which is the double count an application sequencing this by hand has to avoid.
     */
    public settleLayer(entry: CacheEntry, id: number): void
    {
        const layer = entry.layers.find((candidate) => candidate.id === id);
        if (layer === undefined)
        {
            return;
        }
        layer.settled = true;
        let folded = false;
        while (entry.layers[0]?.settled === true)
        {
            const bottom = entry.layers.shift() as OptimisticLayer;
            entry.value = bottom.project(entry.value);
            entry.hasValue = true;
            folded = true;
        }
        if (folded)
        {
            entry.writtenAt = Date.now();
        }
        entry.bumpVersion();
    }

    /** Drops a guess the server refused. The remaining layers re-project the base on next read. */
    public dropLayer(entry: CacheEntry, id: number): void
    {
        const index = entry.layers.findIndex((candidate) => candidate.id === id);
        if (index === -1)
        {
            return;
        }
        entry.layers.splice(index, 1);
        entry.bumpVersion();
    }

    /** The mutation seam: writes a settled value as if fetched, notifying subscribers. */
    public writeEntry(entry: CacheEntry, value: unknown): void
    {
        // A write is newer than anything in flight: the superseded fetch must not
        // overwrite it at settle (stale results never overwrite newer state, for writes
        // exactly as for fetches), and its waiters resolve HERE - the superseded settle
        // exits at the generation guard without touching them, and a stranded waiter
        // would both hang its reader and block eviction forever.
        if (entry.inflight !== null)
        {
            entry.inflight.controller.abort();
            entry.inflight = null;
            this.#resolveWaitersUpTo(entry, Infinity);
        }
        entry.generation += 1;
        entry.value = value;
        entry.hasValue = true;
        entry.hasError = false;
        entry.error = undefined;
        entry.writtenAt = Date.now();
        entry.stale = false;
        entry.bumpVersion();
    }

    public abortAll(): void
    {
        for (const entry of this.#entries.values())
        {
            if (entry.inflight !== null)
            {
                entry.inflight.controller.abort();
                entry.inflight = null;
            }
            this.#resolveWaitersUpTo(entry, Infinity);
        }
    }

    /**
     * The scope-owned teardown: latch first, so nothing re-arms or re-admits from the
     * waiter continuations this very call resolves; then abort, resolve, and drop
     * everything. Waiters resolve BEFORE the map clears - the same order reset() uses -
     * so a detached reader still observes today's settle semantics. Idempotent by the
     * latch. After release, getDataCache answers null for this cache's scope and reads
     * degrade to the cache-disabled path: direct fetch, no entry, no single-flight.
     */
    public release(): void
    {
        if (this.#released)
        {
            return;
        }
        this.#released = true;
        for (const entry of this.#entries.values())
        {
            if (entry.retainTimer !== null)
            {
                clearTimeout(entry.retainTimer);
                entry.retainTimer = null;
            }
            if (entry.inflight !== null)
            {
                entry.inflight.controller.abort();
                entry.inflight = null;
            }
            this.#resolveWaitersUpTo(entry, Infinity);
        }
        this.#entries.clear();
    }

    public reset(): void
    {
        for (const entry of this.#entries.values())
        {
            if (entry.retainTimer !== null)
            {
                clearTimeout(entry.retainTimer);
                entry.retainTimer = null;
            }
            if (entry.inflight !== null)
            {
                entry.inflight.controller.abort();
                entry.inflight = null;
            }
            this.#resolveWaitersUpTo(entry, Infinity);
        }
        this.#entries.clear();
    }
}

const useDataCache = createStore(() => new DataCache(), { name: 'azeroth.data-cache' });

/** Materialized caches by scope, so a request's teardown can abort its outstanding fetches. */
const scopeCaches = new WeakMap<object, DataCache>();

/**
 * Aborts every outstanding entry-fetch of `scope`'s cache, if one ever materialized. The
 * request-end backstop: settle closures must not outlive the request that started them.
 *
 * @internal
 */
export function abortDataCacheFetches(scope: object): void
{
    scopeCaches.get(scope)?.abortAll();
}

/**
 * Releases `scope`'s cache, if one ever materialized: the scope-owning host's teardown
 * call. Runs as the LAST act of teardown - after user cleanups, which may still read the
 * settled entries - and is idempotent, so racing settle paths are harmless.
 *
 * @internal
 */
export function releaseDataCache(scope: object): void
{
    // The scope latches as released even when no cache ever materialized: a straggler
    // whose FIRST read arrives after teardown must not create a live cache that nothing
    // will ever release and whose fetches escape the teardown abort.
    releasedScopes.add(scope);
    scopeCaches.get(scope)?.release();
}

/**
 * The active scope's registry, or `null` when caching is disabled here: a server process
 * resolving to the default scope, where entries would outlive their request and be served
 * across identities. The server is known by positive evidence - a render latched, or an
 * `@azerothjs/http` entry point marked the runtime - never guessed from the environment.
 *
 * @internal
 */
export function getDataCache(): DataCache | null
{
    if ((serverLatched || serverRuntime) && isDefaultScope(getStoreScope()))
    {
        if (DEV && !buildContext)
        {
            if (getRenderMode() === 'dom' && typeof document !== 'undefined')
            {
                if (!disabledBrowserWarned)
                {
                    disabledBrowserWarned = true;
                    console.warn('[azeroth] a server entry point ran in this DOM context, so shared-scope '
                        + 'data caching is disabled. In a test that constructs a server and then exercises '
                        + 'components, call resetDataCache() between the two; real browsers never host server entry points.');
                }
            }
            else if (!disabledServerWarned)
            {
                disabledServerWarned = true;
                console.warn('[azeroth] data caching is disabled at the default scope on this server. '
                    + 'Wrap HTTP work in the request root (runInRequestRoot) and background units - '
                    + 'WebSocket handlers, cron runs - in a work-unit root (runInWorkUnit) so each owns its cache.');
            }
        }
        return null;
    }
    if (releasedScopes.has(getStoreScope()))
    {
        // The scope's host already tore down; a read reaching it now is a dead-frame
        // straggler (a late timer, a still-in-flight pull). No warning - it is not a
        // misconfiguration - and no cache, whether one existed at release or the scope
        // never materialized one: the caller's null path direct-fetches.
        return null;
    }
    const cache = useDataCache();
    if (cache.released)
    {
        // Released through a path that never latched the scope (a direct reset flow);
        // same silent straggler semantics as above.
        return null;
    }
    scopeCaches.set(getStoreScope(), cache);
    return cache;
}

/**
 * Latches server mode: from the first server entry point on, default-scope reads bypass the
 * cache so nothing is ever shared across requests.
 *
 * @internal
 */
export function latchServerData(): void
{
    serverLatched = true;
}

/**
 * Marks the process a server on positive evidence: an `@azerothjs/http` entry point ran.
 * From then on default-scope reads fail closed even where no render ever latches, so a
 * server that only serves an API cannot share one cache across identities.
 *
 * @internal
 */
export function markServerRuntime(): void
{
    serverRuntime = true;
}

/** Marks a build (prerender) context: the disable stands but stays silent. @internal */
export function setBuildContext(active: boolean): void
{
    buildContext = active;
}

/** Test-only: clears the active scope's entries, timers, the server latch and runtime mark. @internal */
export function resetDataCache(): void
{
    untrack(() =>
    {
        useDataCache().reset();
    });
    serverLatched = false;
    serverRuntime = false;
    disabledServerWarned = false;
    disabledBrowserWarned = false;
    buildContext = false;
}

/**
 * Wraps a fetcher into a shared, keyed cache family. Two readers of one key share one
 * request and one entry; `revalidate(fn)` reaches every subscriber.
 *
 * Composes with `createResource` (and the `resource` keyword) as an ordinary fetcher, and
 * is callable directly - a direct call reads through the cache too.
 *
 * @param name - The family's key-space name. One name = one fetcher; reusing a name for a
 *               different fetcher is undefined behavior in production builds.
 * @param fetcher - Receives the arguments and an AbortSignal, returns a promise.
 * @param options - Freshness and retention, see {@link CachedOptions}.
 */
export function cached<F extends (...args: never[]) => Promise<unknown>>(
    name: string,
    fetcher: F,
    options: CachedOptions = {}
): CachedFetcher<DropTrailingSignal<Parameters<F>>, Awaited<ReturnType<F>>>
{
    type A = DropTrailingSignal<Parameters<F>>;
    type T = Awaited<ReturnType<F>>;
    const rawFetcher = fetcher as unknown as FamilyRecord['fetcher'];
    let family: FamilyRecord = {
        name,
        fetcher: rawFetcher,
        fresh: options.fresh ?? 0,
        retain: options.retain ?? DEFAULT_RETAIN_MS
    };

    if (DEV && devFamilies !== null)
    {
        const existing = devFamilies.get(name)?.deref();
        if (existing !== undefined && existing.fetcher !== rawFetcher)
        {
            // Hot module replacement re-evaluates data modules: replace in the SHARED record
            // so live entries fetch through the new code, and drop their settled values. If
            // this logs at cold start, two modules share a family name. The walk reaches
            // app-scope caches only; a scope-owned cache's entries self-evict at their
            // retain window instead - a bound the retain option controls.
            console.info(`[azeroth] cached family '${ name }' re-registered; app-scope entries invalidated `
                + '(scope-owned entries are not walked; unheld ones refresh as their retention '
                + 'expires, so a large retain stretches their staleness accordingly).');
            existing.fetcher = rawFetcher;
            existing.fresh = family.fresh;
            existing.retain = family.retain;
            family = existing;
            devClientCaches?.forEach((cache) =>
            {
                for (const entry of cache.entriesOf(family))
                {
                    void cache.revalidateEntry(entry);
                }
            });
        }
        else if (existing !== undefined)
        {
            // Same fetcher reference: KEEP the shared record - replacing it severs record
            // identity, and a later genuine swap would then mutate the new record while
            // live entries refetch through the old one, serving old code under an
            // invalidation log. Options still land: an options-only edit re-registers with
            // the same imported fetcher.
            existing.fresh = family.fresh;
            existing.retain = family.retain;
            family = existing;
        }
        else
        {
            // A dead WeakRef under this name is simply overwritten; the reaper's liveness
            // re-check keeps it from deleting the fresh registration afterwards.
            devFamilies.set(name, new WeakRef(family));
            devFamilyReaper?.register(family, name);
        }
    }

    const call = (...args: [...A, AbortSignal?]): Promise<T> =>
    {
        const trailing = args.length > 0 && args[args.length - 1] instanceof AbortSignal;
        const plainArgs = (trailing ? args.slice(0, -1) : args) as unknown[];
        const signal = trailing ? args[args.length - 1] as AbortSignal : undefined;
        const cache = getDataCache();
        if (cache === null)
        {
            const controller = new AbortController();
            if (signal !== undefined)
            {
                if (signal.aborted)
                {
                    controller.abort();
                }
                else
                {
                    signal.addEventListener('abort', () => controller.abort(), { once: true });
                }
            }
            return rawFetcher(...plainArgs, controller.signal) as Promise<T>;
        }
        return readValue<T>(cache, family, plainArgs, signal);
    };

    return Object.assign(call, { [CACHED_FAMILY]: family });
}

/**
 * A one-shot value read through the machine: serves a fresh value synchronously-settled,
 * joins or starts the fetch otherwise, and holds a waiter until it resolves.
 *
 * @internal
 */
export function readValue<T>(cache: DataCache, family: FamilyRecord, args: unknown[], signal?: AbortSignal): Promise<T>
{
    const entry = cache.entryFor(family, args);
    if (entry.inflight === null && entry.hasValue && !entry.stale && !entry.hasError)
    {
        // The PROJECTED value, so a one-shot read and a subscribed resource never disagree about
        // the same entry while a guess is in flight.
        return Promise.resolve(projectedValue(entry) as T);
    }
    // A one-shot reader is its own audience: it holds a waiter, so a stale or errored entry
    // fetches for it even with zero subscribers (a fresh consumer always retries).
    cache.ensureFetch(entry);
    const started = entry.inflight;
    if (started === null)
    {
        // Not a synchronous fetcher: #startFetch sets `inflight` before calling it and settles
        // only through a microtask, so even a fetcher that returns an already-resolved promise
        // leaves it set. The reachable route is a fetcher that synchronously writes, forces or
        // resets its OWN key, clearing the entry from under the read that started it.
        if (entry.hasError)
        {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the fetcher's failure propagates VERBATIM to the reader
            return Promise.reject(entry.error);
        }
        if (!entry.hasValue)
        {
            return Promise.reject(new Error('[azeroth] a cached read found no value: its fetcher '
                + 'cleared its own entry while the read was starting.'));
        }
        return Promise.resolve(entry.value as T);
    }
    const awaited = started.startedSeq;
    cache.holdWaiter(entry);
    let released = false;
    const release = (): void =>
    {
        if (!released)
        {
            released = true;
            cache.releaseWaiter(entry);
        }
    };
    if (signal !== undefined)
    {
        if (signal.aborted)
        {
            release();
        }
        else
        {
            signal.addEventListener('abort', release, { once: true });
        }
    }
    return cache.settlementFor(entry, awaited).then(() =>
    {
        if (entry.hasError)
        {
            throw entry.error;
        }
        return entry.value as T;
    }).finally(release);
}

/** Whether a fetcher carries the {@link cached} brand. @internal */
export function cachedFamilyOf(fetcher: unknown): FamilyRecord | null
{
    if (typeof fetcher === 'function' && CACHED_FAMILY in fetcher)
    {
        return (fetcher as CachedFetcher<unknown[], unknown>)[CACHED_FAMILY];
    }
    return null;
}

/**
 * Marks cached data stale and refetches what is being watched.
 *
 * - `revalidate()` - every entry in the active scope.
 * - `revalidate(fn)` - every entry of one `cached` family.
 * - `revalidate(fn, args)` - one entry.
 *
 * Resolves when the refetches it triggered settle; entries with no subscribers are marked
 * and count as settled at the mark - the next subscriber serves the retained value and
 * revalidates behind it.
 */
export function revalidate(target?: CachedFetcher<never[], unknown>, args?: unknown[]): Promise<void>
{
    if (DEV && isStringMode())
    {
        console.warn('[azeroth] revalidate() during a server render is not a supported operation; '
            + 'server reads are one-shot per request and there is nothing to invalidate.');
    }
    const cache = getDataCache();
    if (cache === null)
    {
        return Promise.resolve();
    }
    const family = target !== undefined ? cachedFamilyOf(target) : null;
    if (target !== undefined && family === null)
    {
        throw new TypeError('[azeroth] revalidate targets a cached(...) fetcher.');
    }
    let entries: CacheEntry[];
    if (family === null)
    {
        entries = cache.allEntries();
    }
    else if (args !== undefined)
    {
        const entry = cache.peek(family, args);
        entries = entry !== undefined ? [entry] : [];
    }
    else
    {
        entries = cache.entriesOf(family);
    }
    return Promise.all(entries.map(entry => cache.revalidateEntry(entry))).then(() => undefined);
}
