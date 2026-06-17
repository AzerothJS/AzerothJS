// The devtools agent: the only code that touches the framework. It installs
// the reactivity hook, keeps a live model of nodes (pruned on dispose so it
// reflects the CURRENT page), buffers a bounded event timeline, and answers
// graph/value queries on demand. Everything it returns is JSON-serializable,
// so the same agent drives an in-page panel via direct calls AND a pop-out
// window / browser extension via a postMessage transport that wraps
// `handle()`.
//
// Source attribution: each node's creation stack is captured here (the
// agent's `created` runs synchronously inside createSignal/createEffect, so
// the user's call site is a couple of frames up) and resolved to a /src/
// file:line - what lets the Tree group by component and the Graph label
// nodes by where they live.

import {
    setDevtoolsHook,
    snapshotReactiveGraph,
    peekNode,
    pokeNode,
    type DevtoolsNode,
    type GraphSnapshot
} from '@azerothjs/reactivity';

/** A live node in the agent's model. */
export interface AgentNode
{
    id: number;
    kind: 'signal' | 'effect' | 'memo' | 'root';
    name?: string;
    owner: number;
    /** Source file (relative to /src), or '(unknown)'. */
    file: string;
    /** `file:line`, or ''. */
    loc: string;
    /** Vite open-in-editor path `src/<file>:<line>:<col>`, or ''. */
    open: string;
    runs: number;
    writes: number;
}

/** A point-in-time view of what is alive. */
export interface AgentModel
{
    nodes: AgentNode[];
    counts: { signal: number; effect: number; memo: number; root: number };
    lastWrite: { id: number; name: string } | null;
}

/** One reactive event, for the Timeline. */
export interface TimelineEntry
{
    t: number;
    type: 'created' | 'disposed' | 'run' | 'write';
    id: number;
    kind?: string;
    name?: string;
    /**
     * For `run` events: why it ran - the name of the signal/memo whose write
     * triggered this run, or '(initial)' for a first run. This is the
     * "why did it run?" answer React/Vue devtools approximate.
     */
    cause?: string;
}

/** Per-kind liveness, for the leak detector. */
export interface KindHealth
{
    kind: 'signal' | 'effect' | 'memo' | 'root';
    /** Currently alive. */
    live: number;
    /** Created over the whole session (cumulative). */
    created: number;
    /** Disposed over the whole session (cumulative). */
    disposed: number;
}

/** A health report: liveness per kind plus a suspected-leak flag. */
export interface AgentHealth
{
    kinds: KindHealth[];
    /**
     * Kinds whose live count keeps climbing while almost nothing is ever
     * disposed - the signature of a subscription/effect leak.
     */
    leaks: { kind: string; live: number; disposed: number }[];
}

/** A graph node enriched with the agent's source + activity data. */
export interface AgentGraphNode
{
    id: number;
    kind: 'signal' | 'effect' | 'memo' | 'root';
    name?: string;
    owner: number;
    file: string;
    loc: string;
    open: string;
    runs: number;
    writes: number;
    version?: number;
}

/** The graph the agent serves: enriched nodes + dependency edges. */
export interface AgentGraph
{
    nodes: AgentGraphNode[];
    edges: GraphSnapshot['edges'];
}

/**
 * A complete, JSON-serializable dump of the current devtools state - attach it
 * to a bug report and load it back with the panel's "import" to inspect the
 * graph and timeline offline.
 */
export interface SessionSnapshot
{
    version: number;
    model: AgentModel;
    graph: AgentGraph;
    timeline: TimelineEntry[];
    health: AgentHealth;
    /** Preview strings of signal/memo values at export time, by node id. */
    values: Record<number, string>;
    /** Numeric value history by node id. */
    histories: Record<number, number[]>;
}

/** A transport request (what a pop-out/extension sends over postMessage). */
export type AgentRequest =
    | { kind: 'model' }
    | { kind: 'graph' }
    | { kind: 'timeline' }
    | { kind: 'health' }
    | { kind: 'peek'; id: number }
    | { kind: 'poke'; id: number; value: unknown }
    | { kind: 'history'; id: number }
    | { kind: 'export' }
    | { kind: 'setRecording'; on: boolean }
    | { kind: 'clearTimeline' };

/** The in-process agent API (the in-page panel uses this directly). */
export interface Agent
{
    getModel(): AgentModel;
    getGraph(): AgentGraph;
    getTimeline(): TimelineEntry[];
    getHealth(): AgentHealth;
    /** A full JSON-serializable dump of the current state, for bug reports. */
    exportSession(): SessionSnapshot;
    peek(id: number): { ok: boolean; value?: string };
    poke(id: number, value: unknown): boolean;
    /** Recent numeric values of a signal/memo, oldest-first (for sparklines). */
    getHistory(id: number): number[];
    /** Whether new events are being appended to the timeline. */
    isRecording(): boolean;
    /** Pause/resume timeline capture (the live model keeps updating either way). */
    setRecording(on: boolean): void;
    /** Empty the timeline buffer. */
    clearTimeline(): void;
    /** Coalesced change notifications; returns an unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Serializable request dispatch - the transport boundary. */
    handle(request: AgentRequest): unknown;
    uninstall(): void;
}

const TIMELINE_CAP = 1000;
const HISTORY_CAP = 40;

// Leak detection samples the live effect/memo count on a wall-clock cadence
// (not per-event) so the window spans real time, and only flags SUSTAINED
// growth. A freshly loaded app creates many nodes and disposes none yet - that
// is not a leak, so a single snapshot can never flag it; only a count that
// keeps climbing across the window does.
const SAMPLE_MS = 1000;
const SAMPLE_CAP = 30;

/**
 * True when `samples` (oldest-first live counts) show sustained growth: the
 * recent half is materially and entirely above the older half. A flat plateau
 * or a one-time startup ramp does not qualify. Exported for testing.
 */
export function detectLeakTrend(samples: number[]): boolean
{
    if (samples.length < SAMPLE_CAP)
    {
        return false;
    }
    const mid = Math.floor(samples.length / 2);
    const older = samples.slice(0, mid);
    const recent = samples.slice(mid);
    const avg = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
    // The recent half averages materially higher than the older half AND is
    // still climbing within itself - a plateau (even after a startup ramp)
    // fails the second test, and noise fails the first.
    return avg(recent) > avg(older) + 10 && recent[recent.length - 1] > recent[0];
}

/** Resolves the first /src/ frame of the current stack (creation site). */
function captureOrigin(): { file: string; loc: string; open: string }
{
    const stack = new Error().stack ?? '';
    for (const line of stack.split('\n'))
    {
        if (line.includes('node_modules') || line.includes('/.vite/') || line.includes('@azerothjs'))
        {
            continue;
        }
        const match = /\/src\/([^?\s:)]+)[^:]*:(\d+):(\d+)/.exec(line);
        if (match)
        {
            const [, file, lineNo, col] = match;
            // The `open` form is what Vite's /__open-in-editor middleware
            // resolves (relative to the project root).
            return { file, loc: `${ file }:${ lineNo }`, open: `src/${ file }:${ lineNo }:${ col }` };
        }
    }
    return { file: '(unknown)', loc: '', open: '' };
}

/** Renders any value as a short, transport-safe preview string. */
export function previewValue(v: unknown): string
{
    if (v === null)
    {
        return 'null';
    }
    if (v === undefined)
    {
        return 'undefined';
    }
    const t = typeof v;
    if (t === 'string')
    {
        const s = JSON.stringify(v);
        return s.length > 120 ? `${ s.slice(0, 117) }...` : s;
    }
    if (t === 'number' || t === 'boolean' || t === 'bigint')
    {
        return String(v);
    }
    if (t === 'function')
    {
        return 'fn()';
    }
    if (Array.isArray(v))
    {
        return `Array(${ v.length })`;
    }
    if (t === 'object')
    {
        try
        {
            const s = JSON.stringify(v);
            return s.length > 120 ? `${ s.slice(0, 117) }...` : s;
        }
        catch
        {
            return 'Object';
        }
    }
    return String(v);
}

/**
 * Creates and installs a devtools agent. Install BEFORE mounting so nodes
 * created earlier are captured. Returns the agent; call `uninstall()` to
 * detach the hook.
 *
 * @example
 * ```ts
 * const agent = createAgent();
 * agent.subscribe(() => render(agent.getModel()));
 * ```
 */
export function createAgent(): Agent
{
    const nodes = new Map<number, AgentNode>();
    const timeline: TimelineEntry[] = [];
    // Per-node ring of recent NUMERIC values, for the inspector sparkline.
    const history = new Map<number, number[]>();
    let lastWrite: { id: number; name: string } | null = null;
    // When paused, events stop being appended (the live model keeps updating),
    // so you can reproduce a bug and inspect a frozen event stream.
    let recording = true;

    // Cumulative liveness for the leak detector: these count every node over
    // the whole session and are never pruned, so `created - disposed` reveals
    // nodes that were made but never torn down.
    const totals: Record<'signal' | 'effect' | 'memo' | 'root', { created: number; disposed: number }> = {
        signal: { created: 0, disposed: 0 },
        effect: { created: 0, disposed: 0 },
        memo: { created: 0, disposed: 0 },
        root: { created: 0, disposed: 0 }
    };

    const listeners = new Set<() => void>();
    let notifyQueued = false;

    // Rolling, wall-clock-throttled samples of live effect/memo counts for the
    // trend-based leak detector.
    const effectSamples: number[] = [];
    const memoSamples: number[] = [];
    let lastSampleAt = -Infinity;

    function now(): number
    {
        return typeof performance !== 'undefined' ? performance.now() : 0;
    }

    function recordValue(id: number): void
    {
        const r = peekNode(id);
        if (!r.ok)
        {
            return;
        }
        const n = typeof r.value === 'number' ? r.value
            : typeof r.value === 'boolean' ? (r.value ? 1 : 0)
                : null;
        if (n === null || !Number.isFinite(n))
        {
            return;
        }
        const ring = history.get(id) ?? [];
        ring.push(n);
        if (ring.length > HISTORY_CAP)
        {
            ring.shift();
        }
        history.set(id, ring);
    }

    function push(entry: TimelineEntry): void
    {
        if (!recording)
        {
            return;
        }
        timeline.push(entry);
        if (timeline.length > TIMELINE_CAP)
        {
            timeline.shift();
        }
    }

    function sample(): void
    {
        const at = now();
        if (at - lastSampleAt < SAMPLE_MS)
        {
            return;
        }
        lastSampleAt = at;
        let effects = 0;
        let memos = 0;
        for (const s of nodes.values())
        {
            if (s.kind === 'effect')
            {
                effects++;
            }
            else if (s.kind === 'memo')
            {
                memos++;
            }
        }
        effectSamples.push(effects);
        memoSamples.push(memos);
        if (effectSamples.length > SAMPLE_CAP)
        {
            effectSamples.shift();
        }
        if (memoSamples.length > SAMPLE_CAP)
        {
            memoSamples.shift();
        }
    }

    function scheduleNotify(): void
    {
        sample();
        if (notifyQueued || listeners.size === 0)
        {
            return;
        }
        notifyQueued = true;
        setTimeout(() =>
        {
            notifyQueued = false;
            for (const l of listeners)
            {
                l();
            }
        }, 100);
    }

    const uninstallHook = setDevtoolsHook({
        created(node: DevtoolsNode): void
        {
            const origin = captureOrigin();
            nodes.set(node.id, {
                id: node.id,
                kind: node.kind,
                name: node.name,
                owner: node.owner ?? 0,
                file: origin.file,
                loc: origin.loc,
                open: origin.open,
                runs: 0,
                writes: 0
            });
            totals[node.kind].created++;
            push({ t: now(), type: 'created', id: node.id, kind: node.kind, name: node.name });
            scheduleNotify();
        },
        disposed(id: number): void
        {
            const stats = nodes.get(id);
            if (stats)
            {
                totals[stats.kind].disposed++;
            }
            if (lastWrite !== null && lastWrite.id === id)
            {
                lastWrite = null;
            }
            push({ t: now(), type: 'disposed', id, kind: stats?.kind, name: stats?.name });
            nodes.delete(id);
            history.delete(id);
            scheduleNotify();
        },
        run(id: number): void
        {
            const stats = nodes.get(id);
            // A first run (runs still 0) is the effect's initial execution;
            // any later run was triggered by the most recent write.
            const cause = stats && stats.runs === 0 ? '(initial)' : lastWrite?.name;
            if (stats)
            {
                stats.runs++;
            }
            // A memo's value is (re)computed on run - capture it for the sparkline.
            if (stats?.kind === 'memo')
            {
                recordValue(id);
            }
            push({ t: now(), type: 'run', id, kind: stats?.kind, name: stats?.name, cause });
            scheduleNotify();
        },
        write(id: number): void
        {
            const stats = nodes.get(id);
            if (stats)
            {
                stats.writes++;
                lastWrite = { id, name: stats.name ?? `#${ id }` };
            }
            recordValue(id);
            push({ t: now(), type: 'write', id, kind: stats?.kind, name: stats?.name });
            scheduleNotify();
        }
    });

    function getModel(): AgentModel
    {
        const counts = { signal: 0, effect: 0, memo: 0, root: 0 };
        const list: AgentNode[] = [];
        for (const s of nodes.values())
        {
            counts[s.kind]++;
            list.push(s);
        }
        return { nodes: list, counts, lastWrite };
    }

    function getGraph(): AgentGraph
    {
        const snap = snapshotReactiveGraph();
        const graphNodes: AgentGraphNode[] = snap.nodes.map((n) =>
        {
            const s = nodes.get(n.id);
            return {
                id: n.id,
                kind: n.kind,
                name: n.name,
                owner: n.owner,
                file: s?.file ?? '(unknown)',
                loc: s?.loc ?? '',
                open: s?.open ?? '',
                runs: s?.runs ?? 0,
                writes: s?.writes ?? 0,
                version: n.version
            };
        });
        return { nodes: graphNodes, edges: snap.edges };
    }

    function getHealth(): AgentHealth
    {
        const live = { signal: 0, effect: 0, memo: 0, root: 0 };
        for (const s of nodes.values())
        {
            live[s.kind]++;
        }
        const kinds: KindHealth[] = (['signal', 'effect', 'memo', 'root'] as const).map((kind) => ({
            kind,
            live: live[kind],
            created: totals[kind].created,
            disposed: totals[kind].disposed
        }));
        // A leak is SUSTAINED growth, judged from the live-count trend - not a
        // snapshot, since a freshly loaded app legitimately has many live nodes
        // and zero disposals. Signals are GC'd (no disposed event), so only
        // effects and memos are sampled.
        const leaks: { kind: string; live: number; disposed: number }[] = [];
        if (detectLeakTrend(effectSamples))
        {
            leaks.push({ kind: 'effect', live: live.effect, disposed: totals.effect.disposed });
        }
        if (detectLeakTrend(memoSamples))
        {
            leaks.push({ kind: 'memo', live: live.memo, disposed: totals.memo.disposed });
        }
        return { kinds, leaks };
    }

    function peek(id: number): { ok: boolean; value?: string }
    {
        const result = peekNode(id);
        return result.ok ? { ok: true, value: previewValue(result.value) } : { ok: false };
    }

    function exportSession(): SessionSnapshot
    {
        const model = getModel();
        const values: Record<number, string> = {};
        for (const n of model.nodes)
        {
            if (n.kind === 'signal' || n.kind === 'memo')
            {
                const r = peekNode(n.id);
                if (r.ok)
                {
                    values[n.id] = previewValue(r.value);
                }
            }
        }
        const histories: Record<number, number[]> = {};
        for (const [id, ring] of history)
        {
            histories[id] = ring.slice();
        }
        return {
            version: 1,
            model,
            graph: getGraph(),
            timeline: timeline.slice(),
            health: getHealth(),
            values,
            histories
        };
    }

    function handle(request: AgentRequest): unknown
    {
        switch (request.kind)
        {
            case 'model':
                return getModel();
            case 'graph':
                return getGraph();
            case 'timeline':
                return timeline;
            case 'health':
                return getHealth();
            case 'peek':
                return peek(request.id);
            case 'poke':
                return { ok: pokeNode(request.id, request.value) };
            case 'history':
                return history.get(request.id) ?? [];
            case 'export':
                return exportSession();
            case 'setRecording':
                recording = request.on;
                return { ok: true };
            case 'clearTimeline':
                timeline.length = 0;
                return { ok: true };
            default:
                return null;
        }
    }

    return {
        getModel,
        getGraph,
        getTimeline: () => timeline,
        getHealth,
        exportSession,
        peek,
        poke: (id, value) => pokeNode(id, value),
        getHistory: (id) => history.get(id) ?? [],
        isRecording: () => recording,
        setRecording(on: boolean): void
        {
            recording = on;
        },
        clearTimeline(): void
        {
            timeline.length = 0;
        },
        subscribe(listener: () => void): () => void
        {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        handle,
        uninstall(): void
        {
            uninstallHook();
            nodes.clear();
            timeline.length = 0;
            history.clear();
            listeners.clear();
        }
    };
}
