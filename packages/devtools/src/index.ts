// The in-page devtools panel: a plain-DOM frontend over the agent
// (agent.ts), which is the only code that touches the framework. The panel
// renders the agent's model/graph/timeline and never observes itself (it is
// not built with AzerothJS - see the prompt's hard rule).
//
// Chrome: starts as a small draggable launcher icon (live effect-count
// badge) so it never covers the app. Expand to a tabbed panel - Tree,
// Graph, Timeline, Performance, Settings. The panel can FLOAT (drag +
// corner-resize) or DOCK to the left/right/bottom edge (edge-resize), and
// pop out into its own window. Dock side, size, position, collapsed state,
// and active tab persist in localStorage.
//
// Install BEFORE mounting so nodes created earlier are captured. Dev-only;
// tree-shaken from production builds.

import {
    createAgent,
    type AgentNode,
    type AgentGraph,
    type AgentGraphNode,
    type AgentModel,
    type AgentHealth,
    type TimelineEntry,
    type SessionSnapshot
} from './agent.ts';

export { createAgent, previewValue, detectLeakTrend } from './agent.ts';
export type {
    Agent,
    AgentNode,
    AgentModel,
    AgentGraph,
    AgentGraphNode,
    TimelineEntry,
    AgentHealth,
    KindHealth,
    SessionSnapshot,
    AgentRequest
} from './agent.ts';

const PANEL_ID = 'azeroth-devtools';
const MAX_ROWS = 400;
const UI_KEY = 'azeroth-devtools:ui';

type Dock = 'float' | 'left' | 'right' | 'bottom';
type Tab = 'tree' | 'graph' | 'timeline' | 'perf' | 'settings';

interface UiState
{
    collapsed: boolean;
    dock: Dock;
    tab: Tab;
    floatLeft: number | null;
    floatTop: number | null;
    floatW: number;
    floatH: number;
    dockSize: number;
}

const DEFAULT_UI: UiState = {
    collapsed: true,
    dock: 'float',
    tab: 'tree',
    floatLeft: null,
    floatTop: null,
    floatW: 380,
    floatH: 460,
    dockSize: 360
};

function loadUi(): UiState
{
    try
    {
        const raw = localStorage.getItem(UI_KEY);
        if (raw)
        {
            return { ...DEFAULT_UI, ...(JSON.parse(raw) as Partial<UiState>) };
        }
    }
    catch
    {
        // localStorage unavailable - use defaults.
    }
    return { ...DEFAULT_UI };
}

function saveUi(ui: UiState): void
{
    try
    {
        localStorage.setItem(UI_KEY, JSON.stringify(ui));
    }
    catch
    {
        // Non-fatal.
    }
}

const TABS: { id: Tab; label: string }[] = [
    { id: 'tree', label: 'Tree' },
    { id: 'graph', label: 'Graph' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'perf', label: 'Perf' },
    { id: 'settings', label: 'Settings' }
];

/** @internal */
let active: { uninstall: () => void } | null = null;

/**
 * Installs the devtools panel (and its agent). Idempotent; returns an
 * uninstall function that removes the panel and detaches the agent.
 *
 * @example
 * ```ts
 * import { installDevtools } from '@azerothjs/devtools';
 * installDevtools();
 * ```
 */
export function installDevtools(): () => void
{
    if (active !== null)
    {
        return active.uninstall;
    }

    const agent = createAgent();
    const ui = loadUi();
    let filter = '';
    // The node shown in the inspector drawer (click a row to select).
    let selectedId: number | null = null;
    // Ordered ids of the selectable rows in the current view, for arrow-key
    // navigation; rebuilt every render.
    let navOrder: number[] = [];
    let pointerInPanel = false;
    // When an exported session is imported, the panel renders from it (read
    // only) instead of the live agent.
    let snapshot: SessionSnapshot | null = null;

    // View layer: live agent data, or the imported snapshot when one is loaded.
    function viewModel(): AgentModel
    {
        return snapshot ? snapshot.model : agent.getModel();
    }
    function viewGraph(): AgentGraph
    {
        return snapshot ? snapshot.graph : agent.getGraph();
    }
    function viewTimeline(): TimelineEntry[]
    {
        return snapshot ? snapshot.timeline : agent.getTimeline();
    }
    function viewHealth(): AgentHealth
    {
        return snapshot ? snapshot.health : agent.getHealth();
    }
    function viewHistory(id: number): number[]
    {
        return snapshot ? (snapshot.histories[id] ?? []) : agent.getHistory(id);
    }
    function viewPeek(id: number): { ok: boolean; value?: string }
    {
        if (snapshot)
        {
            const v = snapshot.values[id];
            return v !== undefined ? { ok: true, value: v } : { ok: false };
        }
        return agent.peek(id);
    }

    let root: HTMLElement | null = null;
    let launcher: HTMLElement | null = null;
    let badge: HTMLElement | null = null;
    let panel: HTMLElement | null = null;

    // The agent already coalesces its notifications, so render directly.
    const unsubscribe = agent.subscribe(() => render());
    const justDragged = new WeakSet<HTMLElement>();

    // --- rendering -------------------------------------------------------

    function render(): void
    {
        if (root === null)
        {
            mount();
        }

        const model = viewModel();
        badge!.textContent = String(model.counts.effect);

        const summary = panel!.querySelector('[data-devtools-summary]') as HTMLElement;
        summary.textContent =
            `${ model.counts.signal } sig | ${ model.counts.effect } eff | ${ model.counts.memo } memo` +
            (model.lastWrite ? ` | last: ${ model.lastWrite.name }` : '');

        const content = panel!.querySelector('[data-devtools-content]') as HTMLElement;
        content.textContent = '';
        navOrder = [];

        if (snapshot)
        {
            content.appendChild(snapshotBanner());
        }

        if (ui.tab !== 'settings')
        {
            content.appendChild(legendFor(ui.tab));
        }

        switch (ui.tab)
        {
            case 'tree':
                renderTree(content, model.nodes);
                break;
            case 'graph':
                renderGraph(content, viewGraph());
                break;
            case 'timeline':
                renderTimeline(content);
                break;
            case 'perf':
                renderPerf(content, model.nodes);
                break;
            case 'settings':
                renderSettings(content);
                break;
        }

        renderDetail();
    }

    /** A one-line explainer for the active tab, so rows are self-describing. */
    function legendFor(t: Tab): HTMLElement
    {
        const text: Record<Exclude<Tab, 'settings'>, string> = {
            tree: 'What each component owns. kind | name (#id if unnamed) = value | runs(r) / writes(w). Click a row to inspect.',
            graph: 'Who depends on whom. Each effect/memo lists the signals it reads; orange = changed since last run.',
            timeline: 'Recent events, newest first. run shows "<- cause" (the write that triggered it). Click to inspect.',
            perf: 'Liveness per kind and a sustained-growth leak check, then the busiest nodes. Click a row to inspect.'
        };
        const el = document.createElement('div');
        el.setAttribute('style', 'position:sticky;top:0;background:#101a14;color:#6f9683;padding:4px 0 6px;border-bottom:1px solid #1c3024;margin-bottom:4px;z-index:1');
        el.textContent = text[t as Exclude<Tab, 'settings'>];
        return el;
    }

    /** Banner shown while an imported snapshot is being viewed (read only). */
    function snapshotBanner(): HTMLElement
    {
        const el = document.createElement('div');
        el.setAttribute('style', 'display:flex;gap:8px;align-items:center;background:#1f2e3a;color:#9ec9ff;border:1px solid #2c4a5e;border-radius:4px;padding:4px 8px;margin-bottom:6px');
        const label = document.createElement('span');
        label.setAttribute('style', 'flex:1');
        label.textContent = 'Viewing imported snapshot (read only)';
        const back = smallButton('Return to live', false);
        back.addEventListener('click', () =>
        {
            snapshot = null;
            selectedId = null;
            render();
        });
        el.append(label, back);
        return el;
    }

    function matches(n: AgentNode): boolean
    {
        if (filter === '')
        {
            return true;
        }
        const f = filter.toLowerCase();
        return (n.name ?? '').toLowerCase().includes(f) || n.kind.includes(f) || n.file.toLowerCase().includes(f);
    }

    /** Tree: nodes grouped by the source file that created them. */
    function renderTree(content: HTMLElement, nodes: AgentNode[]): void
    {
        const rows = nodes.filter((n) => n.kind !== 'root' && matches(n));
        const groups = new Map<string, AgentNode[]>();
        for (const n of rows)
        {
            const arr = groups.get(n.file);
            if (arr)
            {
                arr.push(n);
            }
            else
            {
                groups.set(n.file, [n]);
            }
        }
        const ordered = [...groups.entries()].sort((a, b) =>
            activity(b[1]) - activity(a[1]) || b[1].length - a[1].length);

        let shown = 0;
        for (const [file, members] of ordered)
        {
            const head = document.createElement('div');
            head.setAttribute('style', 'margin-top:6px;color:#9fe3c0;font-weight:bold;border-top:1px solid #21382b;padding-top:4px');
            const sig = members.filter((m) => m.kind === 'signal').length;
            const eff = members.filter((m) => m.kind === 'effect').length;
            const memo = members.filter((m) => m.kind === 'memo').length;
            head.textContent = `${ file }  (${ sig } sig, ${ eff } eff${ memo ? `, ${ memo } memo` : '' })`;
            content.appendChild(head);

            for (const n of members.sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes)))
            {
                content.appendChild(nodeRow(n));
                if (++shown >= MAX_ROWS)
                {
                    return;
                }
            }
        }
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';

    /** A small line chart of a signal/memo's recent numeric values. */
    function sparkline(values: number[]): SVGSVGElement
    {
        const w = 220;
        const h = 32;
        const pad = 3;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min || 1;
        const dx = (w - pad * 2) / Math.max(values.length - 1, 1);
        const point = (v: number, i: number): { x: number; y: number } => ({
            x: pad + i * dx,
            y: h - pad - ((v - min) / span) * (h - pad * 2)
        });

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${ w } ${ h }`);
        svg.setAttribute('style', `width:100%;height:${ h }px;background:#0a120d;border:1px solid #1c3024;border-radius:4px`);

        const poly = document.createElementNS(SVG_NS, 'polyline');
        poly.setAttribute('points', values.map((v, i) =>
        {
            const p = point(v, i);
            return `${ p.x.toFixed(1) },${ p.y.toFixed(1) }`;
        }).join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', '#7fd4a8');
        poly.setAttribute('stroke-width', '1.5');
        svg.appendChild(poly);

        // Marker on the latest value.
        const last = point(values[values.length - 1], values.length - 1);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', last.x.toFixed(1));
        dot.setAttribute('cy', last.y.toFixed(1));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', '#ffe9b0');
        svg.appendChild(dot);

        const tip = document.createElementNS(SVG_NS, 'title');
        tip.textContent = `${ values.length } samples  min ${ min }  max ${ max }  now ${ values[values.length - 1] }`;
        svg.appendChild(tip);
        return svg;
    }

    /**
     * A focused dependency map for the selected node: what it reads on the
     * left, the node in the center, what re-runs when it changes on the right.
     * A full 250-node graph is a hairball; the neighborhood is what's useful.
     */
    function svgNeighborhood(graph: AgentGraph, id: number): SVGSVGElement | null
    {
        const node = graph.nodes.find((n) => n.id === id);
        if (!node)
        {
            return null;
        }
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        const reads = graph.edges.filter((e) => e.to === id).slice(0, 8);
        const usedBy = graph.edges.filter((e) => e.from === id).slice(0, 8);

        const rows = Math.max(reads.length, usedBy.length, 1);
        const rowH = 26;
        const padY = 14;
        const width = 320;
        const height = rows * rowH + padY * 2;
        const cy = height / 2;
        const leftX = 6;
        const sideW = 92;
        const centerX = 118;
        const centerW = 84;
        const rightX = 222;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${ width } ${ height }`);
        svg.setAttribute('style', `width:100%;height:${ height }px;margin:2px 0 6px`);

        function box(x: number, y: number, w: number, n: AgentGraphNode, center: boolean): void
        {
            const color = KIND_COLOR[n.kind] ?? '#7fd4a8';
            const g = document.createElementNS(SVG_NS, 'g');
            g.setAttribute('style', 'cursor:pointer');
            g.addEventListener('click', () => select(n.id));

            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', String(x));
            rect.setAttribute('y', String(y - 9));
            rect.setAttribute('width', String(w));
            rect.setAttribute('height', '18');
            rect.setAttribute('rx', '4');
            rect.setAttribute('fill', center ? color : '#18271e');
            rect.setAttribute('stroke', color);
            rect.setAttribute('stroke-width', center ? '0' : '1');

            const text = document.createElementNS(SVG_NS, 'text');
            text.setAttribute('x', String(x + w / 2));
            text.setAttribute('y', String(y + 3));
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('font-size', '10');
            text.setAttribute('font-family', 'ui-monospace,Consolas,monospace');
            text.setAttribute('fill', center ? '#0a120d' : color);
            const label = labelOf(n);
            text.textContent = label.length > 13 ? `${ label.slice(0, 12) }...` : label;
            const tip = document.createElementNS(SVG_NS, 'title');
            tip.textContent = `${ n.kind } ${ label }`;
            g.append(rect, text, tip);
            svg.appendChild(g);
        }

        function link(x1: number, y1: number, x2: number, y2: number, stale: boolean): void
        {
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('x1', String(x1));
            line.setAttribute('y1', String(y1));
            line.setAttribute('x2', String(x2));
            line.setAttribute('y2', String(y2));
            line.setAttribute('stroke', stale ? '#ffcf6b' : '#3a5e48');
            line.setAttribute('stroke-width', '1');
            svg.insertBefore(line, svg.firstChild); // lines behind boxes
        }

        reads.forEach((e, i) =>
        {
            const y = padY + rowH / 2 + i * rowH;
            const p = byId.get(e.from);
            if (p)
            {
                box(leftX, y, sideW, p, false);
            }
            link(leftX + sideW, y, centerX, cy, e.stale);
        });
        usedBy.forEach((e, i) =>
        {
            const y = padY + rowH / 2 + i * rowH;
            const c = byId.get(e.to);
            if (c)
            {
                box(rightX, y, sideW, c, false);
            }
            link(centerX + centerW, cy, rightX, y, e.stale);
        });
        box(centerX, cy, centerW, node, true);
        return svg;
    }

    /** Graph: each consumer and the producers it depends on (adjacency). */
    function renderGraph(content: HTMLElement, graph: AgentGraph): void
    {
        if (selectedId !== null)
        {
            const diagram = svgNeighborhood(graph, selectedId);
            if (diagram)
            {
                const cap = document.createElement('div');
                cap.setAttribute('style', 'color:#8fb8a2;margin:2px 0');
                cap.textContent = 'reads (left)  ->  selected  ->  used by (right)';
                content.append(cap, diagram);
            }
        }
        else
        {
            const hint = document.createElement('div');
            hint.setAttribute('style', 'color:#6f9683;margin:2px 0');
            hint.textContent = 'Tip: click any node to see its dependency map.';
            content.appendChild(hint);
        }

        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        const out = new Map<number, { to: number; stale: boolean }[]>();
        for (const e of graph.edges)
        {
            const arr = out.get(e.to);
            if (arr)
            {
                arr.push({ to: e.from, stale: e.stale });
            }
            else
            {
                out.set(e.to, [{ to: e.from, stale: e.stale }]);
            }
        }

        const consumers = graph.nodes
            .filter((n) => (n.kind === 'effect' || n.kind === 'memo') && (filter === '' || labelOf(n).toLowerCase().includes(filter.toLowerCase())))
            .sort((a, b) => (b.runs - a.runs));

        let shown = 0;
        for (const c of consumers)
        {
            const head = document.createElement('div');
            markRow(head, c.id);
            const sel = c.id === selectedId;
            head.setAttribute('style', `display:flex;gap:6px;align-items:baseline;margin-top:6px;cursor:pointer;border-radius:3px;padding:1px 4px;${ sel ? 'background:#233a2c' : '' }`);
            head.addEventListener('click', () => select(c.id));
            const tag = document.createElement('span');
            tag.setAttribute('style', `color:${ KIND_COLOR[c.kind] ?? '#ffcf6b' };width:42px;flex:none`);
            tag.textContent = c.kind;
            const nm = document.createElement('span');
            nm.setAttribute('style', 'color:#e8f3ec;font-weight:bold');
            nm.textContent = labelOf(c);
            head.append(tag, nm);
            content.appendChild(head);

            for (const dep of out.get(c.id) ?? [])
            {
                const producer = byId.get(dep.to);
                const line = document.createElement('div');
                line.setAttribute('style', `display:flex;gap:6px;padding:0 4px 0 20px;cursor:pointer;color:${ dep.stale ? '#ffcf6b' : '#9ec9ff' }`);
                line.addEventListener('click', () => select(dep.to));
                const arrow = document.createElement('span');
                arrow.setAttribute('style', 'color:#5e7d6c');
                arrow.textContent = 'reads';
                const pn = document.createElement('span');
                pn.textContent = `${ producer ? labelOf(producer) : `#${ dep.to }` }${ dep.stale ? '  (changed)' : '' }`;
                line.append(arrow, pn);
                content.appendChild(line);
            }
            if (++shown >= MAX_ROWS)
            {
                return;
            }
        }
        if (consumers.length === 0)
        {
            empty(content, 'No dependencies yet. Interact with the app.');
        }
    }

    /** Timeline: most recent reactive events, newest first. */
    function renderTimeline(content: HTMLElement): void
    {
        const events = viewTimeline();

        // The record toolbar is live-only; a snapshot's stream is frozen.
        if (snapshot)
        {
            const note = document.createElement('div');
            note.setAttribute('style', 'color:#6f9683;margin:2px 0');
            note.textContent = `${ events.length } events (imported)`;
            content.appendChild(note);
        }
        else
        {
            renderTimelineToolbar(content, events.length);
        }

        const recent = events.slice(-MAX_ROWS).reverse();
        const typeColor: Record<string, string> = {
            write: '#ffcf6b', run: '#7fd4a8', disposed: '#b08aa0', created: '#9ec9ff'
        };
        for (const e of recent)
        {
            const row = document.createElement('div');
            markRow(row, e.id);
            row.setAttribute('style', `display:flex;gap:8px;align-items:baseline;padding:1px 4px;border-radius:3px;cursor:pointer;${ e.type === 'disposed' ? 'opacity:0.55' : '' }`);
            row.addEventListener('click', () => select(e.id));
            const t = document.createElement('span');
            const c = typeColor[e.type] ?? '#9fe3c0';
            t.setAttribute('style', `width:62px;flex:none;text-align:center;background:${ c };color:#0a120d;border-radius:4px;font-weight:bold`);
            t.textContent = e.type;
            const name = document.createElement('span');
            name.setAttribute('style', 'color:#e8f3ec;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
            name.textContent = `${ e.name ?? `#${ e.id }` }${ e.kind ? `  (${ e.kind })` : '' }`;
            row.append(t, name);
            // "why did it run?" - a run shows the write that triggered it.
            if (e.type === 'run' && e.cause)
            {
                const why = document.createElement('span');
                why.setAttribute('style', 'color:#ffcf6b;flex:none');
                why.textContent = `<- ${ e.cause }`;
                row.appendChild(why);
            }
            content.appendChild(row);
        }
        if (recent.length === 0)
        {
            empty(content, 'No events yet.');
        }
    }

    /** The live record/clear toolbar for the Timeline tab. */
    function renderTimelineToolbar(content: HTMLElement, total: number): void
    {
        const bar = document.createElement('div');
        bar.setAttribute('style', 'display:flex;gap:6px;align-items:center;margin:2px 0 6px');
        const rec = agent.isRecording();
        const toggle = document.createElement('button');
        toggle.setAttribute('style', `display:flex;align-items:center;gap:5px;background:${ rec ? '#3a1f1f' : '#18271e' };color:#d7ecdf;border:1px solid ${ rec ? '#5e2c2c' : '#2c4a38' };border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit`);
        const dot = document.createElement('span');
        dot.setAttribute('style', `width:8px;height:8px;border-radius:50%;display:inline-block;background:${ rec ? '#ff5b5b' : '#6f9683' }`);
        const recLabel = document.createElement('span');
        recLabel.textContent = rec ? 'Recording' : 'Paused';
        toggle.append(dot, recLabel);
        toggle.title = rec ? 'Pause capture (model keeps updating)' : 'Resume capture';
        toggle.addEventListener('click', () =>
        {
            agent.setRecording(!agent.isRecording());
            render();
        });
        const clear = smallButton('Clear', false);
        clear.addEventListener('click', () =>
        {
            agent.clearTimeline();
            render();
        });
        const count = document.createElement('span');
        count.setAttribute('style', 'color:#6f9683;margin-left:auto');
        count.textContent = `${ total } event${ total === 1 ? '' : 's' }`;
        bar.append(toggle, clear, count);
        content.appendChild(bar);
    }

    /** Performance: leak detector (liveness per kind) + activity hotspots. */
    function renderPerf(content: HTMLElement, nodes: AgentNode[]): void
    {
        const health = viewHealth();

        if (health.leaks.length > 0)
        {
            const warn = document.createElement('div');
            warn.setAttribute('style', 'background:#3a1f1f;color:#ffb4b4;border:1px solid #5e2c2c;border-radius:4px;padding:4px 8px;margin-bottom:6px');
            const kinds = health.leaks.map((l) => `${ l.live } ${ l.kind }s`).join(', ');
            warn.textContent = `Possible leak: ${ kinds } alive, almost none disposed. Check for missing dispose/onCleanup.`;
            content.appendChild(warn);
        }

        for (const k of health.kinds)
        {
            if (k.created === 0)
            {
                continue;
            }
            const row = document.createElement('div');
            const leaking = health.leaks.some((l) => l.kind === k.kind);
            row.setAttribute('style', `display:flex;gap:8px;${ leaking ? 'color:#ffb4b4' : 'color:#b9d8c8' }`);
            const label = document.createElement('span');
            label.setAttribute('style', `width:54px;flex:none;color:${ KIND_COLOR[k.kind] ?? '#9fe3c0' }`);
            label.textContent = k.kind;
            const stat = document.createElement('span');
            stat.textContent = k.kind === 'signal'
                ? `${ k.live } live  (${ k.created } created)`
                : `${ k.live } live  (${ k.created } created, ${ k.disposed } disposed)`;
            row.append(label, stat);
            content.appendChild(row);
        }

        const hot = document.createElement('div');
        hot.setAttribute('style', 'margin-top:8px;color:#9fe3c0;border-top:1px solid #21382b;padding-top:4px');
        hot.textContent = 'Hotspots (most re-runs / writes)';
        content.appendChild(hot);

        const ranked = nodes
            .filter((n) => n.kind !== 'root' && matches(n))
            .sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes))
            .slice(0, MAX_ROWS);
        for (const n of ranked)
        {
            content.appendChild(nodeRow(n, true));
        }
        if (ranked.length === 0)
        {
            empty(content, 'No activity yet.');
        }
    }

    /** Settings: dock controls, filter, and clear. */
    function renderSettings(content: HTMLElement): void
    {
        const dockRow = document.createElement('div');
        dockRow.setAttribute('style', 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px');
        const dockLabel = document.createElement('span');
        dockLabel.setAttribute('style', 'color:#9fe3c0;margin-right:4px');
        dockLabel.textContent = 'Dock:';
        dockRow.appendChild(dockLabel);
        for (const d of ['float', 'left', 'right', 'bottom'] as Dock[])
        {
            const b = smallButton(d, ui.dock === d);
            b.addEventListener('click', () =>
            {
                ui.dock = d;
                saveUi(ui);
                applyLayout();
                render();
            });
            dockRow.appendChild(b);
        }
        content.appendChild(dockRow);

        const popBtn = smallButton('pop out to window', false);
        popBtn.addEventListener('click', popOut);
        content.appendChild(popBtn);

        // Session export / import - for attaching state to a bug report.
        const sessionRow = document.createElement('div');
        sessionRow.setAttribute('style', 'display:flex;gap:4px;flex-wrap:wrap;margin-top:8px');
        const sessionLabel = document.createElement('span');
        sessionLabel.setAttribute('style', 'color:#9fe3c0;margin-right:4px;width:100%');
        sessionLabel.textContent = 'Session:';
        sessionRow.appendChild(sessionLabel);

        const exportBtn = smallButton('export JSON', false);
        exportBtn.addEventListener('click', () =>
        {
            const json = JSON.stringify(agent.exportSession(), null, 2);
            downloadText('azeroth-devtools-session.json', json);
            void copyText(json);
        });
        const importBtn = smallButton('import', false);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.setAttribute('style', 'display:none');
        fileInput.addEventListener('change', () =>
        {
            const file = fileInput.files?.[0];
            if (file)
            {
                void loadSnapshotFile(file);
            }
        });
        importBtn.addEventListener('click', () => fileInput.click());
        sessionRow.append(exportBtn, importBtn, fileInput);
        content.appendChild(sessionRow);

        if (snapshot)
        {
            const back = smallButton('return to live', false);
            back.addEventListener('click', () =>
            {
                snapshot = null;
                selectedId = null;
                render();
            });
            sessionRow.appendChild(back);
        }

        const hint = document.createElement('div');
        hint.setAttribute('style', 'margin-top:8px;color:#6f9683');
        hint.textContent = 'Name signals/effects for readable rows: createSignal(0, { name: "cart" }).';
        content.appendChild(hint);
    }

    /** Triggers a browser download of a text file. */
    function downloadText(name: string, text: string): void
    {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    function copyText(text: string): Promise<void>
    {
        return navigator.clipboard?.writeText(text).catch(() => undefined) ?? Promise.resolve();
    }

    async function loadSnapshotFile(file: File): Promise<void>
    {
        try
        {
            const parsed = JSON.parse(await file.text()) as SessionSnapshot;
            if (!parsed || typeof parsed !== 'object' || !parsed.model || !parsed.graph)
            {
                return;
            }
            snapshot = parsed;
            selectedId = null;
            ui.tab = 'tree';
            saveUi(ui);
            refreshTabStyles();
            render();
        }
        catch
        {
            // Malformed file - ignore.
        }
    }

    const KIND_COLOR: Record<string, string> = {
        signal: '#7fd4a8',
        memo: '#9ec9ff',
        effect: '#ffcf6b',
        root: '#b08aa0'
    };

    /** Tag a row as selectable: enables arrow-key nav and scroll-into-view. */
    function markRow(el: HTMLElement, id: number): void
    {
        el.setAttribute('data-node-id', String(id));
        if (!navOrder.includes(id))
        {
            navOrder.push(id);
        }
    }

    function nodeRow(n: AgentNode, withLoc = false): HTMLElement
    {
        const row = document.createElement('div');
        markRow(row, n.id);
        const selected = n.id === selectedId;
        row.setAttribute('style', `display:flex;gap:8px;align-items:baseline;padding:1px 6px;cursor:pointer;border-radius:3px;${ selected ? 'background:#233a2c' : '' }`);
        row.addEventListener('mouseenter', () =>
        {
            if (n.id !== selectedId)
            {
                row.style.background = '#18271e';
            }
        });
        row.addEventListener('mouseleave', () =>
        {
            row.style.background = n.id === selectedId ? '#233a2c' : '';
        });
        row.addEventListener('click', () => select(n.id));

        const kind = document.createElement('span');
        kind.setAttribute('style', `width:42px;flex:none;color:${ KIND_COLOR[n.kind] ?? '#7fd4a8' }`);
        kind.textContent = n.kind;

        const name = document.createElement('span');
        name.setAttribute('style', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8f3ec');
        let text = labelOf(n);
        if (n.kind === 'signal' || n.kind === 'memo')
        {
            const peeked = viewPeek(n.id);
            if (peeked.ok)
            {
                text += ` = ${ peeked.value }`;
            }
        }
        if (withLoc && n.loc)
        {
            text += `  ${ n.loc }`;
        }
        name.textContent = text;
        name.title = n.loc || labelOf(n);

        // Labeled counter: "3 runs" / "2 writes" - no cryptic single letters.
        const counters = document.createElement('span');
        counters.setAttribute('style', 'flex:none;color:#8fb8a2');
        if (n.kind === 'signal')
        {
            counters.textContent = `${ n.writes } write${ n.writes === 1 ? '' : 's' }`;
            counters.title = 'How many times this signal has been set.';
        }
        else
        {
            counters.textContent = `${ n.runs } run${ n.runs === 1 ? '' : 's' }`;
            counters.title = 'How many times this effect/memo has executed (initial run included).';
        }

        row.append(kind, name, counters);
        return row;
    }

    function select(id: number): void
    {
        selectedId = selectedId === id ? null : id;
        render();
    }

    function scrollSelectedIntoView(): void
    {
        if (selectedId === null || panel === null)
        {
            return;
        }
        const el = panel.querySelector(`[data-devtools-content] [data-node-id="${ selectedId }"]`);
        el?.scrollIntoView({ block: 'nearest' });
    }

    /** Arrow keys move the selection; Escape closes the inspector. */
    function onKeyDown(e: KeyboardEvent): void
    {
        if (ui.collapsed || panel === null)
        {
            return;
        }
        const tgt = e.target;
        if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement)
        {
            return;
        }
        if (e.key === 'Escape')
        {
            if (selectedId !== null)
            {
                selectedId = null;
                render();
                e.preventDefault();
            }
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
        {
            return;
        }
        // Only claim the arrow keys when the user is actually working in the
        // panel, so app shortcuts keep working otherwise.
        if (!pointerInPanel && selectedId === null)
        {
            return;
        }
        if (navOrder.length === 0)
        {
            return;
        }
        const idx = selectedId === null ? -1 : navOrder.indexOf(selectedId);
        const nextIdx = e.key === 'ArrowDown'
            ? Math.min(idx + 1, navOrder.length - 1)
            : Math.max(idx - 1, 0);
        const next = navOrder[nextIdx < 0 ? 0 : nextIdx];
        if (next !== undefined)
        {
            selectedId = next;
            render();
            scrollSelectedIntoView();
            e.preventDefault();
        }
    }

    /** The inspector drawer: everything known about the selected node. */
    function renderDetail(): void
    {
        const drawer = panel!.querySelector('[data-devtools-detail]') as HTMLElement;
        drawer.textContent = '';

        if (selectedId === null)
        {
            drawer.style.display = 'none';
            return;
        }

        const graph = viewGraph();
        const node = graph.nodes.find((n) => n.id === selectedId);
        if (!node)
        {
            // The node was disposed while selected - clear and hide.
            selectedId = null;
            drawer.style.display = 'none';
            return;
        }
        drawer.style.display = 'block';

        // Title row: colored kind + name + close.
        const title = document.createElement('div');
        title.setAttribute('style', 'display:flex;align-items:center;gap:8px;margin-bottom:6px');
        const tag = document.createElement('span');
        tag.setAttribute('style', `background:${ KIND_COLOR[node.kind] ?? '#7fd4a8' };color:#0a120d;border-radius:4px;padding:0 6px;font-weight:bold`);
        tag.textContent = node.kind;
        const who = document.createElement('strong');
        who.setAttribute('style', 'color:#e8f3ec;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
        who.textContent = `${ node.name ?? `#${ node.id }` }`;
        const close = document.createElement('button');
        close.textContent = 'x';
        close.setAttribute('title', 'Close inspector');
        close.setAttribute('style', barButtonStyle());
        close.addEventListener('click', () =>
        {
            selectedId = null;
            render();
        });
        title.append(tag, who, close);
        drawer.appendChild(title);

        // Source location - click to open in the editor (Vite dev only).
        const srcRow = document.createElement('div');
        srcRow.setAttribute('style', 'display:flex;gap:6px;margin:2px 0;align-items:baseline');
        const srcLbl = document.createElement('span');
        srcLbl.setAttribute('style', 'width:64px;flex:none;color:#8fb8a2');
        srcLbl.textContent = 'source';
        const srcText = node.loc || node.file || '(unknown)';
        if (node.open)
        {
            const link = document.createElement('button');
            link.setAttribute('style', 'flex:1;text-align:left;background:none;border:0;padding:0;color:#9ec9ff;text-decoration:underline;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
            link.textContent = srcText;
            link.title = `Open ${ node.open } in your editor`;
            link.addEventListener('click', () => openInEditor(node.open));
            srcRow.append(srcLbl, link);
        }
        else
        {
            const val = document.createElement('span');
            val.setAttribute('style', 'flex:1;color:#9ec9ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
            val.textContent = srcText;
            srcRow.append(srcLbl, val);
        }
        drawer.appendChild(srcRow);

        // Value + inline edit (signals can be poked; memos are read-only).
        if (node.kind === 'signal' || node.kind === 'memo')
        {
            const peeked = viewPeek(node.id);
            const valRow = document.createElement('div');
            valRow.setAttribute('style', 'display:flex;align-items:center;gap:6px;margin:2px 0');
            const lbl = document.createElement('span');
            lbl.setAttribute('style', 'width:64px;flex:none;color:#8fb8a2');
            lbl.textContent = 'value';
            valRow.appendChild(lbl);

            // Signals are editable live; memos and imported snapshots are read only.
            if (node.kind === 'signal' && !snapshot)
            {
                const input = document.createElement('input');
                input.value = peeked.ok ? String(peeked.value) : '';
                input.setAttribute('style', 'flex:1;background:#0a120d;color:#ffe9b0;border:1px solid #2c4a38;border-radius:4px;padding:2px 6px;font:inherit');
                const set = smallButton('Set', false);
                set.addEventListener('click', () => applyEdit(node.id, input.value));
                input.addEventListener('keydown', (e) =>
                {
                    if ((e as KeyboardEvent).key === 'Enter')
                    {
                        applyEdit(node.id, input.value);
                    }
                });
                valRow.append(input, set);
            }
            else
            {
                const v = document.createElement('span');
                v.setAttribute('style', 'color:#ffe9b0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
                v.textContent = peeked.ok ? String(peeked.value) : '(uncomputed)';
                valRow.appendChild(v);
            }
            drawer.appendChild(valRow);

            // Value-history sparkline (numeric signals/memos only).
            const hist = viewHistory(node.id);
            if (hist.length >= 2)
            {
                const histRow = document.createElement('div');
                histRow.setAttribute('style', 'display:flex;gap:6px;align-items:center;margin:2px 0');
                const lbl = document.createElement('span');
                lbl.setAttribute('style', 'width:64px;flex:none;color:#8fb8a2');
                lbl.textContent = 'history';
                const box = document.createElement('div');
                box.setAttribute('style', 'flex:1;min-width:0');
                box.appendChild(sparkline(hist));
                histRow.append(lbl, box);
                drawer.appendChild(histRow);
            }
        }

        // Activity.
        drawer.appendChild(field(node.kind === 'signal' ? 'writes' : 'runs',
            String(node.kind === 'signal' ? node.writes : node.runs), '#8fb8a2'));

        // Relationships, from the dependency graph.
        const dependsOn = graph.edges.filter((e) => e.to === node.id).map((e) => e.from);
        const usedBy = graph.edges.filter((e) => e.from === node.id).map((e) => e.to);
        drawer.appendChild(relList('reads', dependsOn, graph));
        drawer.appendChild(relList('used by', usedBy, graph));
    }

    /** Opens a source location via Vite's /__open-in-editor middleware. */
    function openInEditor(open: string): void
    {
        if (!open)
        {
            return;
        }
        // Relative URL -> same origin as the dev server. No-op if the endpoint
        // is absent (e.g. a production preview), since the fetch just fails.
        void fetch(`/__open-in-editor?file=${ encodeURIComponent(open) }`).catch(() => undefined);
    }

    function applyEdit(id: number, raw: string): void
    {
        // Try JSON first (numbers, booleans, null, arrays, objects), fall back
        // to the raw string so plain text works without quoting.
        let value: unknown;
        try
        {
            value = JSON.parse(raw);
        }
        catch
        {
            value = raw;
        }
        agent.poke(id, value);
        render();
    }

    function field(label: string, value: string, color: string): HTMLElement
    {
        const row = document.createElement('div');
        row.setAttribute('style', 'display:flex;gap:6px;margin:2px 0');
        const lbl = document.createElement('span');
        lbl.setAttribute('style', 'width:64px;flex:none;color:#8fb8a2');
        lbl.textContent = label;
        const val = document.createElement('span');
        val.setAttribute('style', `flex:1;color:${ color };overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
        val.textContent = value;
        val.title = value;
        row.append(lbl, val);
        return row;
    }

    function relList(label: string, ids: number[], graph: AgentGraph): HTMLElement
    {
        const wrap = document.createElement('div');
        wrap.setAttribute('style', 'display:flex;gap:6px;margin:2px 0');
        const lbl = document.createElement('span');
        lbl.setAttribute('style', 'width:64px;flex:none;color:#8fb8a2');
        lbl.textContent = label;
        const list = document.createElement('span');
        list.setAttribute('style', 'flex:1;display:flex;flex-wrap:wrap;gap:4px');

        if (ids.length === 0)
        {
            const none = document.createElement('span');
            none.setAttribute('style', 'color:#5e7d6c');
            none.textContent = '-';
            list.appendChild(none);
        }
        for (const id of ids)
        {
            const dep = graph.nodes.find((n) => n.id === id);
            const chip = document.createElement('button');
            chip.setAttribute('style', `background:#18271e;color:${ KIND_COLOR[dep?.kind ?? 'signal'] ?? '#7fd4a8' };border:1px solid #2c4a38;border-radius:4px;padding:0 6px;cursor:pointer;font:inherit`);
            chip.textContent = dep ? labelOf(dep) : `#${ id }`;
            chip.addEventListener('click', () => select(id));
            list.appendChild(chip);
        }
        wrap.append(lbl, list);
        return wrap;
    }

    function labelOf(n: { name?: string; id: number }): string
    {
        return n.name ?? `#${ n.id }`;
    }

    function activity(members: AgentNode[]): number
    {
        let n = 0;
        for (const m of members)
        {
            n += m.runs + m.writes;
        }
        return n;
    }

    function empty(content: HTMLElement, message: string): void
    {
        const el = document.createElement('div');
        el.setAttribute('style', 'color:#6f9683;padding:8px 0');
        el.textContent = message;
        content.appendChild(el);
    }

    // --- chrome ----------------------------------------------------------

    function mount(): void
    {
        root = document.createElement('div');
        root.id = PANEL_ID;
        root.setAttribute('style', 'position:fixed;z-index:2147483646;font:11px/1.5 ui-monospace,Consolas,monospace');

        launcher = buildLauncher();
        panel = buildPanel();
        badge = launcher.querySelector('[data-devtools-badge]') as HTMLElement;

        root.append(launcher, panel);
        document.body.appendChild(root);

        panel.addEventListener('mouseenter', () =>
        {
            pointerInPanel = true;
        });
        panel.addEventListener('mouseleave', () =>
        {
            pointerInPanel = false;
        });
        document.addEventListener('keydown', onKeyDown);

        applyLayout();
    }

    function buildLauncher(): HTMLElement
    {
        const el = document.createElement('button');
        el.setAttribute('data-devtools-launcher', '');
        el.setAttribute('title', 'AzerothJS devtools - click to open, drag to move');
        el.setAttribute('style', [
            'display:flex', 'align-items:center', 'gap:6px',
            'background:#101a14', 'color:#7fd4a8', 'border:1px solid #2c4a38',
            'border-radius:999px', 'padding:5px 10px', 'cursor:grab',
            'font:inherit', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)', 'user-select:none'
        ].join(';'));

        const dot = document.createElement('span');
        dot.textContent = 'AZ';
        dot.setAttribute('style', 'font-weight:bold;letter-spacing:1px');
        const b = document.createElement('span');
        b.setAttribute('data-devtools-badge', '');
        b.setAttribute('style', 'background:#2c4a38;color:#d7ecdf;border-radius:999px;padding:0 6px;min-width:14px;text-align:center');
        b.textContent = '0';
        el.append(dot, b);

        el.addEventListener('click', () =>
        {
            if (justDragged.has(el))
            {
                justDragged.delete(el);
                return;
            }
            ui.collapsed = false;
            saveUi(ui);
            applyLayout();
            render();
        });
        makeDraggable(el, true);
        return el;
    }

    function buildPanel(): HTMLElement
    {
        const el = document.createElement('div');
        el.setAttribute('data-devtools-panel', '');
        el.setAttribute('style', [
            'display:flex', 'flex-direction:column', 'overflow:hidden',
            'background:#101a14', 'color:#d7ecdf',
            'border:1px solid #2c4a38', 'border-radius:6px',
            'box-shadow:0 4px 16px rgba(0,0,0,0.5)'
        ].join(';'));

        // Title bar (drag handle when floating).
        const header = document.createElement('div');
        header.setAttribute('data-devtools-header', '');
        header.setAttribute('style', 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:linear-gradient(90deg,#1a3326,#16241c 60%,#241c2e);border-bottom:1px solid #2c4a38;user-select:none;flex:none');

        const heading = document.createElement('strong');
        heading.setAttribute('style', 'color:#7fd4a8;letter-spacing:0.5px;text-shadow:0 0 6px rgba(127,212,168,0.4)');
        heading.textContent = 'AzerothJS';
        const summary = document.createElement('span');
        summary.setAttribute('data-devtools-summary', '');
        summary.setAttribute('style', 'color:#7fd4a8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');

        const collapse = document.createElement('button');
        collapse.textContent = '-';
        collapse.setAttribute('title', 'Collapse to icon');
        collapse.setAttribute('style', barButtonStyle());
        collapse.addEventListener('pointerdown', (e) => e.stopPropagation());
        collapse.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            ui.collapsed = true;
            saveUi(ui);
            applyLayout();
        });

        header.append(heading, summary, collapse);

        // Tab bar.
        const tabbar = document.createElement('div');
        tabbar.setAttribute('style', 'display:flex;gap:2px;padding:4px 6px 0;background:#16241c;flex:none');
        for (const t of TABS)
        {
            const tab = document.createElement('button');
            tab.setAttribute('data-devtools-tab', t.id);
            tab.textContent = t.label;
            tab.setAttribute('style', tabStyle(ui.tab === t.id));
            tab.addEventListener('pointerdown', (e) => e.stopPropagation());
            tab.addEventListener('click', (e) =>
            {
                e.stopPropagation();
                ui.tab = t.id;
                saveUi(ui);
                refreshTabStyles();
                render();
            });
            tabbar.appendChild(tab);
        }

        // Filter.
        const search = document.createElement('input');
        search.setAttribute('placeholder', 'filter by name / file / kind');
        search.setAttribute('style', 'margin:6px;background:#0a120d;color:#d7ecdf;border:1px solid #2c4a38;border-radius:4px;padding:2px 6px;font:inherit;flex:none');
        search.addEventListener('pointerdown', (e) => e.stopPropagation());
        search.addEventListener('input', () =>
        {
            filter = search.value;
            render();
        });
        // Enter jumps straight to the first match's inspector.
        search.addEventListener('keydown', (e) =>
        {
            if ((e as KeyboardEvent).key !== 'Enter')
            {
                return;
            }
            const hit = viewModel().nodes.find((n) => n.kind !== 'root' && matches(n));
            if (hit)
            {
                selectedId = hit.id;
                render();
            }
        });

        // Scrollable content.
        const content = document.createElement('div');
        content.setAttribute('data-devtools-content', '');
        content.setAttribute('style', 'flex:1;overflow:auto;padding:0 8px 8px');

        // Inspector drawer (shown when a node is selected).
        const detail = document.createElement('div');
        detail.setAttribute('data-devtools-detail', '');
        detail.setAttribute('style', 'display:none;flex:none;max-height:45%;overflow:auto;padding:8px;background:#0c1610;border-top:2px solid #2c4a38');

        el.append(header, tabbar, search, content, detail);

        // Resize handle.
        const handle = document.createElement('div');
        handle.setAttribute('data-devtools-resize', '');
        el.appendChild(handle);
        makeResizable(handle);

        makeDraggable(header, false);
        return el;
    }

    function refreshTabStyles(): void
    {
        for (const t of TABS)
        {
            const el = panel!.querySelector(`[data-devtools-tab="${ t.id }"]`) as HTMLElement;
            el.setAttribute('style', tabStyle(ui.tab === t.id));
        }
    }

    // --- layout (dock / float / collapse / resize) -----------------------

    function applyLayout(): void
    {
        if (root === null)
        {
            return;
        }
        launcher!.style.display = ui.collapsed ? 'flex' : 'none';
        panel!.style.display = ui.collapsed ? 'none' : 'flex';

        const handle = panel!.querySelector('[data-devtools-resize]') as HTMLElement;
        const header = panel!.querySelector('[data-devtools-header]') as HTMLElement;

        if (ui.collapsed)
        {
            placeFloating();
            return;
        }

        if (ui.dock === 'float')
        {
            placeFloating();
            panel!.style.width = `${ ui.floatW }px`;
            panel!.style.height = `${ ui.floatH }px`;
            header.style.cursor = 'grab';
            handle.setAttribute('style', resizeHandleStyle('corner'));
            return;
        }

        // Docked: pin to an edge, full span on the cross axis.
        header.style.cursor = 'default';
        root.style.left = ui.dock === 'right' ? 'auto' : '0';
        root.style.right = ui.dock === 'right' ? '0' : 'auto';
        root.style.top = ui.dock === 'bottom' ? 'auto' : '0';
        root.style.bottom = ui.dock === 'bottom' ? '0' : 'auto';

        if (ui.dock === 'bottom')
        {
            panel!.style.width = '100vw';
            panel!.style.height = `${ ui.dockSize }px`;
            handle.setAttribute('style', resizeHandleStyle('top'));
        }
        else
        {
            panel!.style.width = `${ ui.dockSize }px`;
            panel!.style.height = '100vh';
            handle.setAttribute('style', resizeHandleStyle(ui.dock === 'right' ? 'left' : 'right'));
        }
    }

    function placeFloating(): void
    {
        if (ui.floatLeft !== null && ui.floatTop !== null)
        {
            root!.style.left = `${ ui.floatLeft }px`;
            root!.style.top = `${ ui.floatTop }px`;
            root!.style.right = 'auto';
            root!.style.bottom = 'auto';
        }
        else
        {
            root!.style.right = '12px';
            root!.style.bottom = '12px';
            root!.style.left = 'auto';
            root!.style.top = 'auto';
        }
    }

    function makeDraggable(handle: HTMLElement, isLauncher: boolean): void
    {
        handle.addEventListener('pointerdown', (down: PointerEvent) =>
        {
            // Dragging only repositions a floating panel (or the launcher).
            if (down.button !== 0 || root === null || (!isLauncher && ui.dock !== 'float'))
            {
                return;
            }
            const rect = root.getBoundingClientRect();
            const offsetX = down.clientX - rect.left;
            const offsetY = down.clientY - rect.top;
            let moved = 0;
            try
            {
                handle.setPointerCapture(down.pointerId);
            }
            catch
            {
                // setPointerCapture is unsupported in some test environments.
            }

            const move = (e: PointerEvent): void =>
            {
                moved += Math.abs(e.movementX) + Math.abs(e.movementY);
                const left = Math.min(Math.max(0, e.clientX - offsetX), window.innerWidth - rect.width);
                const top = Math.min(Math.max(0, e.clientY - offsetY), window.innerHeight - rect.height);
                root!.style.left = `${ left }px`;
                root!.style.top = `${ top }px`;
                root!.style.right = 'auto';
                root!.style.bottom = 'auto';
            };
            const up = (): void =>
            {
                try
                {
                    handle.releasePointerCapture(down.pointerId);
                }
                catch
                {
                    // No capture to release.
                }
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                if (moved >= 4)
                {
                    justDragged.add(handle);
                    const r = root!.getBoundingClientRect();
                    ui.floatLeft = r.left;
                    ui.floatTop = r.top;
                    saveUi(ui);
                }
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
        });
    }

    function makeResizable(handle: HTMLElement): void
    {
        handle.addEventListener('pointerdown', (down: PointerEvent) =>
        {
            if (down.button !== 0 || panel === null)
            {
                return;
            }
            down.stopPropagation();
            const startX = down.clientX;
            const startY = down.clientY;
            const startW = ui.dock === 'float' ? ui.floatW : ui.dockSize;
            const startH = ui.dock === 'float' ? ui.floatH : ui.dockSize;
            try
            {
                handle.setPointerCapture(down.pointerId);
            }
            catch
            {
                // setPointerCapture is unsupported in some test environments.
            }

            const move = (e: PointerEvent): void =>
            {
                if (ui.dock === 'float')
                {
                    ui.floatW = Math.max(260, Math.min(startW + (e.clientX - startX), window.innerWidth - 20));
                    ui.floatH = Math.max(200, Math.min(startH + (e.clientY - startY), window.innerHeight - 20));
                }
                else if (ui.dock === 'bottom')
                {
                    ui.dockSize = Math.max(120, Math.min(startH - (e.clientY - startY), window.innerHeight - 20));
                }
                else if (ui.dock === 'left')
                {
                    ui.dockSize = Math.max(220, Math.min(startW + (e.clientX - startX), window.innerWidth - 20));
                }
                else
                {
                    ui.dockSize = Math.max(220, Math.min(startW - (e.clientX - startX), window.innerWidth - 20));
                }
                applyLayout();
            };
            const up = (): void =>
            {
                try
                {
                    handle.releasePointerCapture(down.pointerId);
                }
                catch
                {
                    // No capture to release.
                }
                handle.removeEventListener('pointermove', move);
                handle.removeEventListener('pointerup', up);
                saveUi(ui);
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
        });
    }

    // --- pop-out ---------------------------------------------------------

    function popOut(): void
    {
        const win = window.open('', 'azeroth-devtools', 'width=440,height=560');
        if (!win)
        {
            return;
        }
        win.document.title = 'AzerothJS devtools';
        win.document.body.style.cssText = 'margin:0;background:#101a14;color:#d7ecdf;font:12px/1.5 ui-monospace,Consolas,monospace';
        const host = win.document.createElement('pre');
        host.style.cssText = 'padding:10px;white-space:pre-wrap';
        win.document.body.appendChild(host);

        // Same-origin window: read the agent directly, no transport needed.
        const tick = (): void =>
        {
            if (win.closed)
            {
                win.clearInterval(timer);
                return;
            }
            const m = agent.getModel();
            const lines = [`signals ${ m.counts.signal }  effects ${ m.counts.effect }  memos ${ m.counts.memo }`, ''];
            for (const n of m.nodes.filter((x) => x.kind !== 'root').sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes)).slice(0, 200))
            {
                const v = (n.kind === 'signal' || n.kind === 'memo') ? agent.peek(n.id) : { ok: false };
                lines.push(`${ n.kind.padEnd(6) } ${ (n.name ?? `#${ n.id }`).padEnd(20) } ${ v.ok ? `= ${ v.value }` : '' }  ${ n.file }`);
            }
            host.textContent = lines.join('\n');
        };
        const timer = win.setInterval(tick, 400);
        tick();
    }

    // --- styles ----------------------------------------------------------

    function barButtonStyle(): string
    {
        return 'background:#2c4a38;color:#d7ecdf;border:0;border-radius:4px;width:20px;height:18px;cursor:pointer;font:inherit;line-height:1;flex:none';
    }

    function tabStyle(activeTab: boolean): string
    {
        return `background:${ activeTab ? '#2c4a38' : 'transparent' };color:${ activeTab ? '#fff' : '#9fe3c0' };border:0;border-radius:4px 4px 0 0;padding:3px 8px;cursor:pointer;font:inherit`;
    }

    function smallButton(label: string, on: boolean): HTMLElement
    {
        const b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('style', `background:${ on ? '#3a5e48' : '#2c4a38' };color:#d7ecdf;border:0;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit`);
        return b;
    }

    function resizeHandleStyle(where: 'corner' | 'left' | 'right' | 'top'): string
    {
        const base = 'position:absolute;background:transparent;z-index:1';
        if (where === 'corner')
        {
            return `${ base };right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize`;
        }
        if (where === 'top')
        {
            return `${ base };left:0;top:0;width:100%;height:6px;cursor:ns-resize`;
        }
        return `${ base };${ where }:0;top:0;width:6px;height:100%;cursor:ew-resize`;
    }

    function uninstall(): void
    {
        if (active === null)
        {
            return;
        }
        active = null;
        unsubscribe();
        document.removeEventListener('keydown', onKeyDown);
        agent.uninstall();
        root?.remove();
        root = null;
        launcher = null;
        panel = null;
        badge = null;
    }

    active = { uninstall };
    return uninstall;
}
