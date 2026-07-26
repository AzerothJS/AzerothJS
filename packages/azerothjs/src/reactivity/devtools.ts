/**
 * MODULE: reactivity/devtools - the stable, versioned runtime-debugging hook
 *
 * This is the ONE supported way for an external tool (the in-page panel in `@azerothjs/devtools`, a
 * browser-extension agent, a test harness) to observe the live reactive graph. It is deliberately small
 * and explicitly VERSIONED so the protocol can evolve without silently breaking consumers: a hook
 * declares nothing, but {@link DEVTOOLS_PROTOCOL_VERSION} and the snapshot's `version` field let an agent
 * detect a mismatch.
 *
 * ZERO-COST WHEN DETACHED: until {@link setDevtoolsHook} installs a hook, every instrumentation point is
 * a single `hook === null` comparison and nothing else - no ids are minted, no registry grows, no events
 * fire. Nodes created BEFORE a hook attaches are invisible to it (install before mounting to see them),
 * which is what keeps the production hot path free of bookkeeping. While a hook IS attached the registry
 * holds references to live nodes; it is pruned on every dispose, so it never outlives the page's nodes
 * (the agent is a dev-only tool, tree-shaken from production builds).
 *
 * WHAT IT EXPOSES: lifecycle events (created / disposed / run / write) with the owning root and, for the
 * graph view, a point-in-time {@link GraphSnapshot} of every live node plus its dependency edges, and
 * {@link peekNode}/{@link pokeNode} to read or set a signal's current value from the panel.
 */

import type { Producer, Subscriber } from './types.ts';

/**
 * The devtools wire-protocol version. Bumped on any breaking change to {@link DevtoolsHook},
 * {@link DevtoolsNode}, or {@link GraphSnapshot}. An agent compares this (and `GraphSnapshot.version`)
 * against what it was built for and can refuse / degrade on a mismatch instead of misreading data.
 */
export const DEVTOOLS_PROTOCOL_VERSION = 2;

/** The kind of a reactive node, as surfaced to devtools. */
export type DevtoolsNodeKind = 'signal' | 'memo' | 'effect' | 'root';

/**
 * The higher-level primitive a node was created inside. The base kinds stay the substrate: a
 * resource IS its data/loading/error signals plus a fetch effect. This tag lets a panel present
 * those nodes as the primitive the user declared instead of an anonymous pile of internals. A bare
 * `state`/`derived`/`effect` needs no tag - its kind (ungrouped signal/memo/effect) already says it.
 */
export type DevtoolsPrimitive = 'store' | 'resource' | 'stream' | 'selector' | 'deferred' | 'form';

/** A reactive node as announced to the hook at creation. */
export interface DevtoolsNode
{
    /** Stable, monotonic id for this node's lifetime (never reused). */
    id: number;

    /** What kind of reactive primitive this is. */
    kind: DevtoolsNodeKind;

    /** Optional debug name (from the primitive's `options.name`). Explicit undefined is
     * equivalent to absent. */
    name?: string | undefined;

    /** Id of the owning root, or 0 when created outside any root. */
    owner: number;

    /** The higher-level primitive this node is part of; absent for a bare signal/memo/effect/root. */
    primitive?: DevtoolsPrimitive | undefined;

    /** Groups every node of one primitive instance (a stable per-instance id); 0/absent = ungrouped. */
    group?: number | undefined;

    /** The primitive instance's debug name, repeated on every member of the group. */
    groupName?: string | undefined;
}

/**
 * The observer an agent installs via {@link setDevtoolsHook}. Every method is called synchronously from
 * inside the corresponding primitive, so an agent capturing a stack trace finds the user's call site a
 * few frames up. All methods are required so the runtime never has to null-check individual callbacks on
 * the hot path; an agent that ignores an event supplies an empty function.
 */
export interface DevtoolsHook
{
    /** A signal/memo/effect/root was created. */
    created(node: DevtoolsNode): void;

    /** The node `id` was disposed and removed from the graph. */
    disposed(id: number): void;

    /**
     * An effect or memo (`id`) executed (its body ran). `cause` is the id of the DIRECT producer
     * whose change triggered this run (a signal for a first-level consumer, the memo in between for
     * one further down), or 0 for an initial/untriggered run.
     */
    run(id: number, cause: number): void;

    /** A signal (`id`) was written (its value changed). */
    write(id: number): void;
}

/** One live node in a {@link GraphSnapshot}. */
export interface GraphSnapshotNode
{
    id: number;
    kind: DevtoolsNodeKind;
    name?: string | undefined;
    owner: number;
    primitive?: DevtoolsPrimitive | undefined;
    group?: number | undefined;
    groupName?: string | undefined;
    /** Producer version (bumps on value change); 0 for a pure consumer (effect/root). */
    version: number;
    /** Number of consumers currently subscribed to this node (0 for a pure consumer). */
    subscribers: number;
    /** Number of producers this node currently reads (0 for a pure producer/root). */
    sources: number;
}

/** A dependency edge: the consumer `to` reads the producer `from`. */
export interface GraphEdge
{
    from: number;
    to: number;
    /** True when the consumer's recorded version of the producer lags the producer's current version - i.e. the producer changed but this consumer has not yet re-validated/re-run against it. */
    stale: boolean;
}

/** A point-in-time view of the whole live reactive graph. */
export interface GraphSnapshot
{
    /** The protocol version this snapshot was produced under. */
    version: number;
    nodes: GraphSnapshotNode[];
    edges: GraphEdge[];
}

/** The result of {@link peekNode}: a value when the node exists and is readable. */
export interface PeekResult
{
    ok: boolean;
    value?: unknown;
}

/** What the registry holds for a live node so the snapshot/peek/poke can serve it. @internal */
interface NodeRecord
{
    kind: DevtoolsNodeKind;
    name?: string | undefined;
    owner: number;
    primitive?: DevtoolsPrimitive | undefined;
    group?: number | undefined;
    groupName?: string | undefined;
    /** The producer id stamped by the most recent write reaching this consumer; consumed by the next run. */
    pendingCause?: number;
    /** The producer side (signal value, memo cache, or a memo acting as a producer). */
    producer?: Producer;
    /** The consumer side (effect, or a memo acting as a consumer). */
    subscriber?: Subscriber;
    /** Reads the node's current value (signals + memos). */
    getValue?: () => unknown;
    /** Sets the node's value (signals only). */
    setValue?: (value: unknown) => void;
}

/** The installed hook, or null when no devtools is attached (the common case -> near-zero overhead). @internal */
let hook: DevtoolsHook | null = null;

/** Live nodes by id, populated only while a hook is attached and pruned on dispose. @internal */
const registry = new Map<number, NodeRecord>();

/** Monotonic id source; never resets, so an id uniquely identifies a node for the session. @internal */
let nextId = 1;

/** The owning root's devtools id for nodes created in the current scope; threaded like the active root. @internal */
let currentOwner = 0;

/** The active primitive-construction frame: nodes registered while set belong to that instance. @internal */
interface PrimitiveFrame
{
    primitive: DevtoolsPrimitive;
    group: number;
    name?: string | undefined;
}

/**
 * The primitive-frame stack. Constructors push on entry and truncate back on exit WITHOUT
 * try/finally; a frame leaked by a throwing constructor (a user getter running inside a creation-
 * time effect) is healed at the enclosing root boundary - {@link dtExitOwner} truncates to the
 * depth captured by {@link dtEnterOwner}, and createRoot's own finally always runs that pair.
 *
 * @internal
 */
const frameStack: PrimitiveFrame[] = [];

/** Frame depth captured per owner entry, restored (with truncation) on owner exit. @internal */
const ownerFrameDepths: number[] = [];

/** Group-id source for primitive instances; separate from node ids so neither space aliases the other. @internal */
let nextGroup = 1;

/**
 * Installs a devtools hook and returns an uninstall function. Replacing an existing hook is allowed (the
 * previous one stops receiving events). On uninstall the registry is cleared so no node references are
 * retained.
 *
 * @param next - The observer to receive reactive lifecycle events.
 * @returns A function that detaches this hook.
 */
export function setDevtoolsHook(next: DevtoolsHook): () => void
{
    hook = next;
    return (): void =>
    {
        if (hook === next)
        {
            hook = null;
            registry.clear();
            frameStack.length = 0;
        }
    };
}

/**
 * True when a devtools hook is attached. Callers gate the CONSTRUCTION of a node's registration
 * record on this: the record (an object literal, often carrying getValue/setValue closures) would
 * otherwise be allocated per signal/effect/root only for dtRegister to discard it - pure GC
 * pressure on the hottest creation paths.
 *
 * @internal
 */
export function dtEnabled(): boolean
{
    return hook !== null;
}

/**
 * Registers a newly created node and announces it to the hook. Returns the assigned id, or 0 when no
 * hook is attached (the caller stores 0 and skips all later devtools work for that node). The owning
 * root id is captured automatically from the active scope.
 *
 * @internal
 */
export function dtRegister(
    kind: DevtoolsNodeKind,
    record: Omit<NodeRecord, 'kind' | 'owner'> & { name?: string | undefined }
): number
{
    if (hook === null)
    {
        return 0;
    }
    const id = nextId++;
    const full: NodeRecord = { kind, owner: currentOwner, ...record };
    const frame = frameStack[frameStack.length - 1];
    if (frame !== undefined)
    {
        full.primitive = frame.primitive;
        full.group = frame.group;
        full.groupName = frame.name;
    }
    registry.set(id, full);
    if (full.producer !== undefined)
    {
        full.producer.devtoolsId = id;
    }
    if (full.subscriber !== undefined)
    {
        full.subscriber.devtoolsId = id;
    }
    hook.created({
        id,
        kind,
        name: full.name,
        owner: full.owner,
        primitive: full.primitive,
        group: full.group,
        groupName: full.groupName
    });
    return id;
}

/**
 * Opens a primitive-construction frame: every node registered until the matching
 * {@link dtExitPrimitive} is stamped as belonging to this instance of `primitive`. Frames nest
 * (a store building a resource attributes the resource's internals to the resource); the deepest
 * frame wins. Returns the depth token to pass to {@link dtExitPrimitive}.
 *
 * @internal
 */
export function dtEnterPrimitive(primitive: DevtoolsPrimitive, name?: string): number
{
    const depth = frameStack.length;
    if (hook !== null)
    {
        frameStack.push({ primitive, group: nextGroup++, name });
    }
    return depth;
}

/**
 * Closes the frame opened at `depth` (and, by truncation, any inner frame a throw leaked past
 * its own exit). @internal
 */
export function dtExitPrimitive(depth: number): void
{
    if (frameStack.length > depth)
    {
        frameStack.length = depth;
    }
}

/**
 * Pushes `id` as the active owner for nodes created inside a root body; returns the previous
 * owner to restore. Also captures the primitive-frame depth: {@link dtExitOwner} runs in
 * createRoot's finally, so a frame leaked inside the root (a throwing constructor) is truncated
 * at the root boundary instead of mis-stamping everything created after it.
 *
 * @internal
 */
export function dtEnterOwner(id: number): number
{
    const previous = currentOwner;
    currentOwner = id;
    ownerFrameDepths.push(frameStack.length);
    return previous;
}

/** Restores the active owner after a root body returns, healing any leaked primitive frames. @internal */
export function dtExitOwner(previous: number): void
{
    currentOwner = previous;
    const depth = ownerFrameDepths.pop();
    if (depth !== undefined && frameStack.length > depth)
    {
        frameStack.length = depth;
    }
}

/**
 * Announces a node's disposal and drops it from the registry. No-op when the node was never
 * registered. When a ROOT disposes, also sweep any of its still-registered nodes - signals have no
 * disposal event of their own (they are GC'd), so without this sweep every signal a disposed
 * component created would be pinned in the registry forever while a hook is attached (a dev-session
 * memory leak, and phantom nodes in the graph snapshot).
 *
 * @internal
 */
export function dtDispose(id: number): void
{
    if (hook === null || id === 0)
    {
        return;
    }
    const record = registry.get(id);
    registry.delete(id);
    hook.disposed(id);
    if (record?.kind === 'root')
    {
        for (const [childId, child] of registry)
        {
            if (child.owner === id)
            {
                registry.delete(childId);
                hook.disposed(childId);
            }
        }
    }
}

/**
 * Stamps `fromId` as the pending run-cause on every consumer subscribed to `producer`, then
 * recurses through consumers that are themselves producers (memos) stamping THEM as the cause one
 * level further down - so each consumer attributes its next run to its DIRECT dependency, not the
 * original signal. The `pendingCause === fromId` short-circuit doubles as the cycle guard.
 *
 * @internal
 */
function stampCauses(fromId: number, producer: Producer, depth: number): void
{
    if (depth > 32)
    {
        return;
    }
    for (const link of producer.subs)
    {
        const subId = link.consumer.devtoolsId ?? 0;
        if (subId === 0)
        {
            continue;
        }
        const record = registry.get(subId);
        if (record === undefined || record.pendingCause === fromId)
        {
            continue;
        }
        record.pendingCause = fromId;
        if (record.producer !== undefined)
        {
            stampCauses(subId, record.producer, depth + 1);
        }
    }
}

/** Announces that effect/memo `id` ran, with the producer that triggered it (0 = initial run). @internal */
export function dtRun(id: number): void
{
    if (hook === null || id === 0)
    {
        return;
    }
    const record = registry.get(id);
    const cause = record?.pendingCause ?? 0;
    if (record !== undefined)
    {
        record.pendingCause = 0;
    }
    hook.run(id, cause);
}

/** Announces that signal `id` was written, and stamps its downstream consumers' run-causes. @internal */
export function dtWrite(id: number): void
{
    if (hook === null || id === 0)
    {
        return;
    }
    const producer = registry.get(id)?.producer;
    if (producer !== undefined)
    {
        stampCauses(id, producer, 0);
    }
    hook.write(id);
}

/**
 * Builds a point-in-time snapshot of the live reactive graph: every registered node plus the dependency
 * edges between them (producer -> consumer). Edges are derived from each consumer's live dependency list,
 * so they reflect the CURRENT subscription state, not a historical one.
 *
 * @returns The graph snapshot (empty when no hook is attached).
 */
export function snapshotReactiveGraph(): GraphSnapshot
{
    const nodes: GraphSnapshotNode[] = [];
    const edges: GraphEdge[] = [];

    for (const [id, record] of registry)
    {
        nodes.push({
            id,
            kind: record.kind,
            name: record.name,
            owner: record.owner,
            primitive: record.primitive,
            group: record.group,
            groupName: record.groupName,
            version: record.producer?.version ?? 0,
            subscribers: record.producer?.subs.length ?? 0,
            sources: record.subscriber?.deps.length ?? 0
        });

        // Edges from this node's dependency list: each producer it reads -> this consumer.
        const deps = record.subscriber?.deps;
        if (deps !== undefined)
        {
            for (const link of deps)
            {
                const fromId = link.producer.devtoolsId ?? 0;
                if (fromId !== 0)
                {
                    edges.push({ from: fromId, to: id, stale: link.version !== link.producer.version });
                }
            }
        }
    }

    return { version: DEVTOOLS_PROTOCOL_VERSION, nodes, edges };
}

/**
 * Reads the current value of a node (signals and memos). Returns `{ ok: false }` for an unknown node or
 * one with no readable value (an effect/root). The read is UNTRACKED - peeking from the panel must not
 * subscribe anything.
 *
 * @param id - The node id.
 * @returns `{ ok, value }`.
 */
export function peekNode(id: number): PeekResult
{
    const record = registry.get(id);
    if (record === undefined || record.getValue === undefined)
    {
        return { ok: false };
    }
    return { ok: true, value: record.getValue() };
}

/**
 * Sets the value of a signal node from the panel. Returns false for an unknown node or one that is not
 * writable (a memo/effect/root). The write goes through the real setter, so it propagates normally.
 *
 * @param id - The node id.
 * @param value - The new value.
 * @returns Whether the write was applied.
 */
export function pokeNode(id: number, value: unknown): boolean
{
    const record = registry.get(id);
    if (record === undefined || record.setValue === undefined)
    {
        return false;
    }
    record.setValue(value);
    return true;
}
