// The devtools surface. Two complementary channels, both inert in
// production (every instrumentation point is gated by `devtoolsHook` being
// non-null, which it is only after setDevtoolsHook):
//
//   1. An EVENT stream - created/disposed/run/write - for the live activity
//      view (counts, what just ran, what changed). Cheap and push-based.
//   2. A SNAPSHOT api - snapshotReactiveGraph/peekNode/pokeNode - walked ON
//      DEMAND so the hot path stays free of edge bookkeeping. This is what
//      powers the dependency graph, the ownership tree, and live state
//      inspection/editing.
//
// Leak-safety: the snapshot registry holds nodes by WeakRef only, so
// devtools never keeps a GC-managed signal alive. The rich data (id, owner,
// value accessors) lives on the node's `dv` field (see types.ts), which
// shares the node's lifetime - no extra retention. Dead WeakRefs are pruned
// lazily on snapshot.

import type { Producer, Subscriber, DevtoolsInfo } from './types.ts';

/** A node announcement: identity, kind, name, and enclosing owner. */
export interface DevtoolsNode
{
    id: number;
    kind: 'signal' | 'effect' | 'memo' | 'root';
    name?: string;
    /** Enclosing createRoot's devtools id at creation, or 0. */
    owner?: number;
}

/** The receiver devtools implementations register. */
export interface DevtoolsHook
{
    /** A reactive node (or ownership root) came into existence. */
    created(node: DevtoolsNode): void;

    /** The node was disposed (effects/memos/roots; signals are GC-managed). */
    disposed(id: number): void;

    /** An effect's body ran / a memo recomputed. */
    run(id: number): void;

    /** A signal's value actually changed (post-equals). */
    write(id: number): void;
}

/**
 * The active hook, or null. Instrumentation points read this directly;
 * keep it a plain module binding so the off-path is one load + compare.
 *
 * @internal
 */
export let devtoolsHook: DevtoolsHook | null = null;

/** @internal */
let idCounter = 0;

/**
 * Allocates a devtools node id. Only called when a hook is installed at
 * node creation; 0 means "untracked node" everywhere.
 *
 * @internal
 */
export function nextDevtoolsId(): number
{
    return ++idCounter;
}

/**
 * The enclosing createRoot's devtools id, read by create sites as the
 * `owner` of every node they make. createRoot saves/restores it the way it
 * does `currentRoot`. 0 = no owning root.
 *
 * @internal
 */
export let currentOwnerId = 0;

/** @internal */
export function setCurrentOwnerId(id: number): void
{
    currentOwnerId = id;
}

// The snapshot registry: id -> WeakRef of the node's primary object (a
// signal's producer, an effect/memo's subscriber). The `dv` on that object
// carries everything the snapshot needs.
type DvHolder = (Producer | Subscriber) & { dv?: DevtoolsInfo; deps?: import('./types.ts').Link[] };

/** @internal */
const registry = new Map<number, WeakRef<DvHolder>>();

/**
 * Registers a node's primary object for snapshot/peek/poke. The object must
 * carry its `dv`. Held weakly, so registration never extends the node's
 * lifetime.
 *
 * @internal
 */
export function registerDevtoolsNode(id: number, holder: object): void
{
    registry.set(id, new WeakRef(holder as DvHolder));
}

/** Drops a node from the registry (effects/memos/roots, on dispose). @internal */
export function unregisterDevtoolsNode(id: number): void
{
    registry.delete(id);
}

/** A node in a graph snapshot. */
export interface SnapshotNode
{
    id: number;
    kind: 'signal' | 'effect' | 'memo' | 'root';
    name?: string;
    owner: number;
    /** Producer version (signals/memos), for change/staleness analysis. */
    version?: number;
}

/** A dependency edge: `from` (a producer) is read by `to` (a consumer). */
export interface SnapshotEdge
{
    from: number;
    to: number;
    /** Whether `to`'s recorded version for this link is behind `from`'s
     *  current version - i.e. this dependency changed since `to` last ran. */
    stale: boolean;
}

/** A full reactive-graph snapshot. */
export interface GraphSnapshot
{
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
}

/**
 * Walks the live reactive graph and returns its nodes and dependency edges.
 * On-demand (never evented), so the hot path carries no edge bookkeeping.
 * Prunes dead WeakRefs as it goes.
 *
 * @internal Consumed by the devtools agent.
 */
export function snapshotReactiveGraph(): GraphSnapshot
{
    const nodes: SnapshotNode[] = [];
    const edges: SnapshotEdge[] = [];

    for (const [id, ref] of registry)
    {
        const holder = ref.deref();
        if (holder === undefined || holder.dv === undefined)
        {
            registry.delete(id);
            continue;
        }
        const dv = holder.dv;

        const producer = dv.kind === 'signal'
            ? (holder as Producer)
            : dv.producer;
        nodes.push({
            id: dv.id,
            kind: dv.kind,
            name: dv.name,
            owner: dv.owner,
            version: producer?.version
        });

        // Outgoing dependency edges: this consumer reads these producers.
        const deps = (holder as DvHolder).deps;
        if (deps)
        {
            for (const link of deps)
            {
                const fromId = link.producer.dv?.id;
                if (fromId !== undefined)
                {
                    edges.push({ from: fromId, to: dv.id, stale: link.version !== link.producer.version });
                }
            }
        }
    }

    return { nodes, edges };
}

/** The current value of a signal/memo node, or undefined if unavailable. */
export function peekNode(id: number): { ok: boolean; value?: unknown }
{
    const dv = registry.get(id)?.deref()?.dv;
    if (dv?.peek)
    {
        return { ok: true, value: dv.peek() };
    }
    return { ok: false };
}

/** Sets a signal node's value from the panel. Returns whether it applied. */
export function pokeNode(id: number, value: unknown): boolean
{
    const dv = registry.get(id)?.deref()?.dv;
    if (dv?.poke)
    {
        dv.poke(value);
        return true;
    }
    return false;
}

/**
 * Installs a devtools hook, returning an unregister function that restores
 * the previous one and clears the snapshot registry. Install BEFORE
 * mounting - nodes created earlier carry no id and stay invisible.
 *
 * @example
 * ```ts
 * const uninstall = setDevtoolsHook({
 *     created: (node) => console.log('created', node),
 *     disposed: (id) => console.log('disposed', id),
 *     run: (id) => console.log('run', id),
 *     write: (id) => console.log('write', id)
 * });
 * // later:
 * uninstall();
 * ```
 */
export function setDevtoolsHook(hook: DevtoolsHook): () => void
{
    const previous = devtoolsHook;
    devtoolsHook = hook;
    return (): void =>
    {
        devtoolsHook = previous;
        if (previous === null)
        {
            registry.clear();
        }
    };
}
