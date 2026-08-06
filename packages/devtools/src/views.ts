// The panel's views: Components (primitive-aware, virtualized), Timeline (burst-grouped),
// Graph (neighborhood + adjacency), Performance (health + hotspots), and the Inspector pane.
// Each view renders into the main scroll container from the shared PanelCtx; the shell owns
// chrome, layout, and persistence.

import type { Agent, AgentGraph, AgentGraphNode, AgentHealth, AgentModel, AgentNode, TimelineEntry } from './agent.ts';
import { el, SVG_NS } from './dom.ts';
import { KIND_COLOR, PRIMITIVE_COLOR, EVENT_COLOR } from './theme.ts';

/** What every view receives: data accessors plus the interaction state the shell owns. */
export interface PanelCtx
{
    agent: Agent;
    /** False while an imported snapshot is being viewed (read-only). */
    live: boolean;
    filter: string;
    selectedId: number | null;
    /** Ordered ids of selectable rows in the current view; views rebuild it each render. */
    navOrder: number[];
    openGroups: Set<number>;
    openBursts: Set<number>;
    model(): AgentModel;
    graph(): AgentGraph;
    timeline(): TimelineEntry[];
    health(): AgentHealth;
    history(id: number): number[];
    peek(id: number): { ok: boolean; value?: string };
    select(id: number): void;
    openInEditor(open: string): void;
    rerender(): void;
}

const ROW_H = 22;
const MAX_ROWS = 400;

/** A node's display label; grouped members read as `group.member`. */
export function labelOf(n: { name?: string | undefined; groupName?: string | undefined; id: number }): string
{
    const own = n.name ?? `#${ n.id }`;
    return n.groupName !== undefined && n.name !== undefined && n.groupName !== n.name
        ? `${ n.groupName }.${ own }`
        : own;
}

/** The user-facing badge for a node: its declared keyword, not the substrate kind. */
function badgeOf(n: AgentNode): { label: string; color: string }
{
    if (n.primitive !== undefined)
    {
        return { label: n.primitive, color: PRIMITIVE_COLOR[n.primitive] ?? '#8aa0b5' };
    }
    if (n.kind === 'signal')
    {
        return { label: 'state', color: KIND_COLOR['signal'] ?? '#5fb3e8' };
    }
    if (n.kind === 'memo')
    {
        return { label: 'derived', color: KIND_COLOR['memo'] ?? '#b48ef0' };
    }
    return { label: n.kind, color: KIND_COLOR[n.kind] ?? '#8aa0b5' };
}

function matches(n: AgentNode, filter: string): boolean
{
    if (filter === '')
    {
        return true;
    }
    const f = filter.toLowerCase();
    return (n.name ?? '').toLowerCase().includes(f)
        || (n.groupName ?? '').toLowerCase().includes(f)
        || n.kind.includes(f)
        || (n.primitive ?? '').includes(f)
        || n.file.toLowerCase().includes(f);
}

function activity(nodes: AgentNode[]): number
{
    let total = 0;
    for (const n of nodes)
    {
        total += n.runs + n.writes;
    }
    return total;
}

/** A teaching empty state: what will appear here and how to cause it. */
export function emptyState(main: HTMLElement, title: string, hint: string): void
{
    const box = el('div', 'az-empty');
    box.append(el('div', 'az-empty-title', title), el('div', 'az-empty-hint', hint));
    main.appendChild(box);
}

// --- Components (the primary view) --------------------------------------------------------

type Row =
    | { type: 'file'; file: string; meta: string }
    | { type: 'group'; id: number; primitive: string; name: string; meta: string; status: { cls: string; label: string } | null; anchor: number }
    | { type: 'node'; node: AgentNode; member: boolean };

/** Derives a primitive instance's live status from its members' current values. */
function groupStatus(ctx: PanelCtx, primitive: string, members: AgentNode[]): { cls: string; label: string } | null
{
    const value = (name: string): string | null =>
    {
        const m = members.find((x) => x.name === name);
        if (m === undefined)
        {
            return null;
        }
        const p = ctx.peek(m.id);
        return p.ok ? p.value ?? null : null;
    };
    if (primitive === 'resource')
    {
        if (value('loading') === 'true')
        {
            return { cls: 'warn', label: 'pending' };
        }
        const err = value('error');
        if (err !== null && err !== 'null')
        {
            return { cls: 'err', label: 'error' };
        }
        return { cls: 'ok', label: 'ready' };
    }
    if (primitive === 'stream')
    {
        return value('done') === 'false' ? { cls: 'warn', label: 'streaming' } : { cls: 'ok', label: 'idle' };
    }
    if (primitive === 'form')
    {
        if (value('submitting') === 'true')
        {
            return { cls: 'warn', label: 'submitting' };
        }
        const errors = value('errors');
        return errors !== null && errors.includes('":"')
            ? { cls: 'err', label: 'invalid' }
            : { cls: 'ok', label: 'valid' };
    }
    return null;
}

/** Flattens the model into virtualizable rows: file -> primitive groups -> loose nodes. */
function buildRows(ctx: PanelCtx): Row[]
{
    const nodes = ctx.model().nodes.filter((n) => n.kind !== 'root' && matches(n, ctx.filter));
    const byFile = new Map<string, AgentNode[]>();
    for (const n of nodes)
    {
        const arr = byFile.get(n.file);
        if (arr)
        {
            arr.push(n);
        }
        else
        {
            byFile.set(n.file, [n]);
        }
    }
    const files = [...byFile.entries()].sort((a, b) =>
        activity(b[1]) - activity(a[1]) || b[1].length - a[1].length);

    const rows: Row[] = [];
    for (const [file, members] of files)
    {
        const groups = new Map<number, AgentNode[]>();
        const loose: AgentNode[] = [];
        for (const n of members)
        {
            if (n.group !== undefined)
            {
                const g = groups.get(n.group);
                if (g)
                {
                    g.push(n);
                }
                else
                {
                    groups.set(n.group, [n]);
                }
            }
            else
            {
                loose.push(n);
            }
        }

        const state = loose.filter((n) => n.kind === 'signal').length;
        const derived = loose.filter((n) => n.kind === 'memo').length;
        const effects = loose.filter((n) => n.kind === 'effect').length;
        const parts: string[] = [];
        if (groups.size > 0)
        {
            parts.push(`${ groups.size } primitive${ groups.size === 1 ? '' : 's' }`);
        }
        if (state > 0)
        {
            parts.push(`${ state } state`);
        }
        if (derived > 0)
        {
            parts.push(`${ derived } derived`);
        }
        if (effects > 0)
        {
            parts.push(`${ effects } effect${ effects === 1 ? '' : 's' }`);
        }
        rows.push({ type: 'file', file, meta: parts.join(' | ') });

        const orderedGroups = [...groups.entries()].sort((a, b) => activity(b[1]) - activity(a[1]));
        for (const [groupId, groupMembers] of orderedGroups)
        {
            const first = groupMembers[0];
            if (first === undefined)
            {
                continue;
            }
            const primitive = first.primitive ?? 'store';
            const name = first.groupName ?? `#${ groupId }`;
            const anchor = groupMembers.find((m) => m.kind === 'signal')?.id ?? first.id;
            rows.push({
                type: 'group',
                id: groupId,
                primitive,
                name,
                meta: `${ groupMembers.length } node${ groupMembers.length === 1 ? '' : 's' }`,
                status: groupStatus(ctx, primitive, groupMembers),
                anchor
            });
            if (ctx.openGroups.has(groupId))
            {
                for (const m of groupMembers.sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes)))
                {
                    rows.push({ type: 'node', node: m, member: true });
                }
            }
        }

        for (const n of loose.sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes)))
        {
            rows.push({ type: 'node', node: n, member: false });
        }
    }
    return rows;
}

function renderRow(ctx: PanelCtx, row: Row): HTMLElement
{
    if (row.type === 'file')
    {
        const head = el('div', 'az-filehead');
        head.append(el('span', '', row.file), el('span', 'meta', row.meta));
        return head;
    }
    if (row.type === 'group')
    {
        const open = ctx.openGroups.has(row.id);
        const head = el('div', `az-grouphead${ ctx.selectedId === row.anchor ? ' sel' : '' }`);
        head.setAttribute('data-node-id', String(row.anchor));
        const caret = el('span', 'az-caret', open ? 'v' : '>');
        const prim = el('span', 'az-prim', row.primitive);
        prim.style.background = PRIMITIVE_COLOR[row.primitive] ?? '#8aa0b5';
        head.append(caret, prim, el('span', 'az-groupname', row.name));
        if (row.status !== null)
        {
            head.appendChild(el('span', `az-status ${ row.status.cls }`, row.status.label));
        }
        head.appendChild(el('span', 'az-groupmeta', row.meta));
        head.addEventListener('click', () =>
        {
            if (open)
            {
                ctx.openGroups.delete(row.id);
            }
            else
            {
                ctx.openGroups.add(row.id);
            }
            ctx.rerender();
        });
        return head;
    }

    const n = row.node;
    const badge = badgeOf(n);
    const selected = n.id === ctx.selectedId;
    const div = el('div', `az-row${ row.member ? ' az-member' : '' }${ selected ? ' sel' : '' }`);
    div.setAttribute('data-node-id', String(n.id));
    div.addEventListener('click', () => ctx.select(n.id));

    const kind = el('span', `az-kind${ row.member ? ' dim' : '' }`, row.member ? n.kind : badge.label);
    if (!row.member)
    {
        kind.style.background = badge.color;
    }
    const name = el('span', 'az-name az-mono', n.name ?? `#${ n.id }`);
    div.append(kind, name);

    if (n.kind === 'signal' || n.kind === 'memo')
    {
        const peeked = ctx.peek(n.id);
        if (peeked.ok)
        {
            div.appendChild(el('span', 'az-val az-mono', `= ${ peeked.value }`));
        }
        else
        {
            div.appendChild(el('span', 'az-spacer'));
        }
    }
    else
    {
        div.appendChild(el('span', 'az-spacer'));
    }

    const count = n.kind === 'signal'
        ? `${ n.writes } write${ n.writes === 1 ? '' : 's' }`
        : `${ n.runs } run${ n.runs === 1 ? '' : 's' }`;
    div.appendChild(el('span', 'az-count', count));
    return div;
}

/**
 * The Components view: file -> declared primitives -> loose state/derived/effects, windowed so a
 * tree of any size renders a bounded slice (the wrap carries the full scroll height; only rows
 * around the viewport exist in the DOM).
 */
export function renderComponents(ctx: PanelCtx, main: HTMLElement): void
{
    const rows = buildRows(ctx);
    ctx.navOrder = [];
    for (const r of rows)
    {
        if (r.type === 'group')
        {
            ctx.navOrder.push(r.anchor);
        }
        else if (r.type === 'node')
        {
            ctx.navOrder.push(r.node.id);
        }
    }

    if (rows.length === 0)
    {
        emptyState(main, ctx.filter === '' ? 'Nothing mounted yet' : 'No matches',
            ctx.filter === ''
                ? 'Every state, derived, effect, form, resource, store, stream and selector your components declare appears here as it is created. Interact with the app to see it live.'
                : 'No node, primitive, kind, or file matches this filter. Clear it to see everything again.');
        return;
    }

    const wrap = el('div');
    wrap.style.position = 'relative';
    wrap.style.height = `${ rows.length * ROW_H }px`;
    const slice = el('div');
    slice.style.cssText = 'position:absolute;left:0;right:0';
    wrap.appendChild(slice);
    main.appendChild(wrap);

    const paint = (): void =>
    {
        const start = Math.max(0, Math.floor(main.scrollTop / ROW_H) - 8);
        const end = Math.min(rows.length, start + Math.ceil(main.clientHeight / ROW_H) + 16);
        slice.style.top = `${ start * ROW_H }px`;
        slice.textContent = '';
        for (let i = start; i < end; i++)
        {
            const r = rows[i];
            if (r !== undefined)
            {
                slice.appendChild(renderRow(ctx, r));
            }
        }
    };
    main.onscroll = paint;
    paint();
}

/** Scrolls the selected row into the virtual window (index math, not DOM search). */
export function scrollToSelected(ctx: PanelCtx, main: HTMLElement): void
{
    if (ctx.selectedId === null)
    {
        return;
    }
    const idx = ctx.navOrder.indexOf(ctx.selectedId);
    if (idx < 0)
    {
        return;
    }
    const target = idx * ROW_H;
    if (target < main.scrollTop || target > main.scrollTop + main.clientHeight - ROW_H)
    {
        main.scrollTop = Math.max(0, target - main.clientHeight / 2);
    }
}

// --- Timeline ------------------------------------------------------------------------------

interface Burst
{
    key: number;
    entries: TimelineEntry[];
}

/** Groups entries into bursts: one flush of writes/runs reads as one row, expandable. */
function toBursts(entries: TimelineEntry[]): Burst[]
{
    const bursts: Burst[] = [];
    let current: Burst | null = null;
    let lastT = -Infinity;
    for (const e of entries)
    {
        if (current === null || e.t - lastT > 60)
        {
            current = { key: e.t, entries: [e] };
            bursts.push(current);
        }
        else
        {
            current.entries.push(e);
        }
        lastT = e.t;
    }
    return bursts;
}

function eventRow(ctx: PanelCtx, e: TimelineEntry, inBurst: boolean): HTMLElement
{
    const row = el('div', `az-ev${ e.type === 'disposed' ? ' faded' : '' }${ e.id === ctx.selectedId ? ' sel' : '' }${ inBurst ? ' az-member' : '' }`);
    row.setAttribute('data-node-id', String(e.id));
    row.addEventListener('click', () => ctx.select(e.id));
    const tag = el('span', 'az-evtag', e.type);
    tag.style.background = EVENT_COLOR[e.type] ?? '#8aa0b5';
    row.append(tag, el('span', 'az-name az-mono', `${ e.name ?? `#${ e.id }` }${ e.kind !== undefined ? ` (${ e.kind })` : '' }`));
    if (e.type === 'run' && e.cause !== undefined)
    {
        const cause = el('span', 'az-cause', `<- ${ e.cause }`);
        cause.title = 'The producer whose change triggered this run. Click to inspect it.';
        if (e.causeId !== undefined)
        {
            const causeId = e.causeId;
            cause.addEventListener('click', (ev) =>
            {
                ev.stopPropagation();
                ctx.select(causeId);
            });
        }
        row.appendChild(cause);
    }
    row.appendChild(el('span', 'az-spacer'));
    row.appendChild(el('span', 'az-time', `${ (e.t / 1000).toFixed(1) }s`));
    return row;
}

/** The Timeline view: newest-first bursts with pause/resume and clear. */
export function renderTimeline(ctx: PanelCtx, main: HTMLElement): void
{
    main.onscroll = null;
    const events = ctx.timeline();
    ctx.navOrder = [];

    if (ctx.live)
    {
        const bar = el('div', 'az-legend');
        bar.style.display = 'flex';
        bar.style.gap = '6px';
        bar.style.alignItems = 'center';
        const recording = ctx.agent.isRecording();
        const toggle = el('button', `az-btn${ recording ? '' : ' on' }`, recording ? 'Pause' : 'Resume');
        toggle.title = recording ? 'Pause capture (the live model keeps updating)' : 'Resume capture';
        toggle.addEventListener('click', () =>
        {
            ctx.agent.setRecording(!recording);
            ctx.rerender();
        });
        const clear = el('button', 'az-btn', 'Clear');
        clear.addEventListener('click', () =>
        {
            ctx.agent.clearTimeline();
            ctx.rerender();
        });
        const count = el('span', 'az-spacer');
        count.style.textAlign = 'right';
        count.textContent = `${ events.length } event${ events.length === 1 ? '' : 's' }`;
        bar.append(toggle, clear, count);
        main.appendChild(bar);
    }

    if (events.length === 0)
    {
        emptyState(main, 'No events yet',
            'Every write, run, creation and disposal lands here, newest first. A run shows the producer that triggered it. Interact with the app to see the stream.');
        return;
    }

    const bursts = toBursts(events).reverse();
    let shown = 0;
    for (const b of bursts)
    {
        if (b.entries.length === 1)
        {
            const first = b.entries[0];
            if (first !== undefined)
            {
                main.appendChild(eventRow(ctx, first, false));
                ctx.navOrder.push(first.id);
                shown++;
            }
        }
        else
        {
            const open = ctx.openBursts.has(b.key);
            const head = el('div', 'az-bursthead');
            const counts = new Map<string, number>();
            for (const e of b.entries)
            {
                counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
            }
            const summary = [...counts.entries()].map(([t, c]) => `${ c } ${ t }${ c === 1 ? '' : 's' }`).join(', ');
            head.append(
                el('span', 'az-caret', open ? 'v' : '>'),
                el('span', '', `batch - ${ summary }`),
                el('span', 'az-spacer'),
                el('span', 'az-time', `${ (b.key / 1000).toFixed(1) }s`)
            );
            head.addEventListener('click', () =>
            {
                if (open)
                {
                    ctx.openBursts.delete(b.key);
                }
                else
                {
                    ctx.openBursts.add(b.key);
                }
                ctx.rerender();
            });
            main.appendChild(head);
            shown++;
            if (open)
            {
                for (const e of [...b.entries].reverse())
                {
                    main.appendChild(eventRow(ctx, e, true));
                    ctx.navOrder.push(e.id);
                    shown++;
                }
            }
        }
        if (shown >= MAX_ROWS)
        {
            return;
        }
    }
}

// --- Graph ---------------------------------------------------------------------------------

/** A focused dependency map: reads on the left, the node centered, dependents on the right. */
function svgNeighborhood(ctx: PanelCtx, graph: AgentGraph, id: number): SVGSVGElement | null
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
        const color = KIND_COLOR[n.kind] ?? '#5fb3e8';
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('style', 'cursor:pointer');
        g.addEventListener('click', () => ctx.select(n.id));

        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y - 9));
        rect.setAttribute('width', String(w));
        rect.setAttribute('height', '18');
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', center ? color : '#141c25');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', center ? '0' : '1');

        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', String(x + w / 2));
        text.setAttribute('y', String(y + 3));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '10');
        text.setAttribute('font-family', 'ui-monospace,Consolas,monospace');
        text.setAttribute('fill', center ? '#090d12' : color);
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
        line.setAttribute('stroke', stale ? '#e2b95a' : '#2a3a4d');
        line.setAttribute('stroke-width', '1');
        svg.insertBefore(line, svg.firstChild);
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

/** The Graph view: the selected node's neighborhood, then consumer adjacency. */
export function renderGraph(ctx: PanelCtx, main: HTMLElement): void
{
    main.onscroll = null;
    const graph = ctx.graph();
    ctx.navOrder = [];

    if (ctx.selectedId !== null)
    {
        const diagram = svgNeighborhood(ctx, graph, ctx.selectedId);
        if (diagram)
        {
            main.appendChild(el('div', 'az-legend', 'reads (left) -> selected -> re-runs when it changes (right)'));
            main.appendChild(diagram);
        }
    }
    else
    {
        main.appendChild(el('div', 'az-legend', 'Click any node to see its dependency neighborhood.'));
    }

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const readsOf = new Map<number, { from: number; stale: boolean }[]>();
    for (const e of graph.edges)
    {
        const arr = readsOf.get(e.to);
        if (arr)
        {
            arr.push({ from: e.from, stale: e.stale });
        }
        else
        {
            readsOf.set(e.to, [{ from: e.from, stale: e.stale }]);
        }
    }

    const f = ctx.filter.toLowerCase();
    const consumers = graph.nodes
        .filter((n) => (n.kind === 'effect' || n.kind === 'memo') && (f === '' || labelOf(n).toLowerCase().includes(f)))
        .sort((a, b) => b.runs - a.runs);

    if (consumers.length === 0)
    {
        emptyState(main, 'No dependencies yet',
            'Each effect and derived value appears here with the signals it reads. Amber means the producer changed since the consumer last ran.');
        return;
    }

    let shown = 0;
    for (const c of consumers)
    {
        const row = el('div', `az-row${ c.id === ctx.selectedId ? ' sel' : '' }`);
        row.setAttribute('data-node-id', String(c.id));
        row.addEventListener('click', () => ctx.select(c.id));
        ctx.navOrder.push(c.id);
        const kind = el('span', 'az-kind', c.kind);
        kind.style.background = KIND_COLOR[c.kind] ?? '#8aa0b5';
        row.append(kind, el('span', 'az-name az-mono', labelOf(c)), el('span', 'az-spacer'),
            el('span', 'az-count', `${ c.runs } run${ c.runs === 1 ? '' : 's' }`));
        main.appendChild(row);

        for (const dep of readsOf.get(c.id) ?? [])
        {
            const producer = byId.get(dep.from);
            const line = el('div', 'az-row az-member');
            line.addEventListener('click', () => ctx.select(dep.from));
            const arrow = el('span', 'az-count', 'reads');
            const pn = el('span', 'az-name az-mono', producer ? labelOf(producer) : `#${ dep.from }`);
            if (dep.stale)
            {
                pn.style.color = '#e2b95a';
                pn.textContent += '  (changed)';
            }
            line.append(arrow, pn);
            main.appendChild(line);
        }
        if (++shown >= MAX_ROWS)
        {
            return;
        }
    }
}

// --- Performance ---------------------------------------------------------------------------

/** The Performance view: per-kind liveness, the leak trend, and activity hotspots. */
export function renderPerf(ctx: PanelCtx, main: HTMLElement): void
{
    main.onscroll = null;
    const health = ctx.health();
    ctx.navOrder = [];

    if (health.leaks.length > 0)
    {
        const kinds = health.leaks.map((l) => `${ l.live } ${ l.kind }s`).join(', ');
        main.appendChild(el('div', 'az-warnbox',
            `Possible leak: ${ kinds } alive and climbing while almost none dispose. Check for a missing dispose/onCleanup.`));
    }

    for (const k of health.kinds)
    {
        if (k.created === 0)
        {
            continue;
        }
        const row = el('div', 'az-row');
        row.style.cursor = 'default';
        const kind = el('span', 'az-kind', k.kind);
        kind.style.background = KIND_COLOR[k.kind] ?? '#8aa0b5';
        const leaking = health.leaks.some((l) => l.kind === k.kind);
        const stat = el('span', 'az-name', k.kind === 'signal'
            ? `${ k.live } live (${ k.created } created)`
            : `${ k.live } live (${ k.created } created, ${ k.disposed } disposed)`);
        if (leaking)
        {
            stat.style.color = '#e06b6b';
        }
        row.append(kind, stat);
        main.appendChild(row);
    }

    main.appendChild(el('div', 'az-section', 'Hotspots - most re-runs and writes'));

    const ranked = ctx.model().nodes
        .filter((n) => n.kind !== 'root' && matches(n, ctx.filter))
        .sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes))
        .slice(0, 100);
    const top = ranked[0] !== undefined ? ranked[0].runs + ranked[0].writes : 0;

    if (ranked.length === 0 || top === 0)
    {
        emptyState(main, 'No activity yet',
            'The busiest nodes surface here with a relative activity bar - the first place to look when something re-renders too often.');
        return;
    }

    for (const n of ranked)
    {
        const total = n.runs + n.writes;
        if (total === 0)
        {
            break;
        }
        const row = el('div', `az-row${ n.id === ctx.selectedId ? ' sel' : '' }`);
        row.setAttribute('data-node-id', String(n.id));
        row.addEventListener('click', () => ctx.select(n.id));
        ctx.navOrder.push(n.id);
        const badge = badgeOf(n);
        const kind = el('span', 'az-kind', badge.label);
        kind.style.background = badge.color;
        const bar = el('span', 'az-bar');
        const fill = el('i');
        fill.style.width = `${ Math.max(2, Math.round((total / top) * 100)) }%`;
        bar.appendChild(fill);
        row.append(kind, el('span', 'az-name az-mono', labelOf(n)), bar, el('span', 'az-count', String(total)));
        main.appendChild(row);
    }
}

// --- Server --------------------------------------------------------------------------------

/** The Server view: teaches how to enable the bridge; the live client replaces this content. */
export function renderServer(ctx: PanelCtx, main: HTMLElement): void
{
    main.onscroll = null;
    ctx.navOrder = [];
    emptyState(main, 'Server inspection',
        'Call attachDevtools(served.server, { token }) from @azerothjs/devtools/server on your backend (dev only), then connect above with that token in the URL query - this tab streams the server\'s reactive graph, where every request is a reactive root.');
}

// --- Inspector -----------------------------------------------------------------------------

function fieldRow(label: string, valueEl: HTMLElement): HTMLElement
{
    const row = el('div', 'az-field');
    row.append(el('span', 'az-fieldlbl', label), valueEl);
    return row;
}

/** A tiny line chart of a signal/memo's recent numeric values. */
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
    svg.setAttribute('style', `width:100%;height:${ h }px;background:#090d12;border:1px solid #1e2a38;border-radius:4px`);

    const poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', values.map((v, i) =>
    {
        const p = point(v, i);
        return `${ p.x.toFixed(1) },${ p.y.toFixed(1) }`;
    }).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', '#5fb3e8');
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);

    const last = point(values[values.length - 1] ?? 0, values.length - 1);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', last.x.toFixed(1));
    dot.setAttribute('cy', last.y.toFixed(1));
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', '#e8c88f');
    svg.appendChild(dot);

    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = `${ values.length } samples  min ${ min }  max ${ max }  now ${ values[values.length - 1] }`;
    svg.appendChild(tip);
    return svg;
}

function chips(ctx: PanelCtx, ids: number[], graph: AgentGraph): HTMLElement
{
    const list = el('span', 'az-chips');
    if (ids.length === 0)
    {
        list.appendChild(el('span', 'az-fieldval', '-'));
    }
    for (const id of ids)
    {
        const dep = graph.nodes.find((n) => n.id === id);
        const chip = el('button', 'az-chip az-mono', dep ? labelOf(dep) : `#${ id }`);
        chip.style.color = KIND_COLOR[dep?.kind ?? 'signal'] ?? '#5fb3e8';
        chip.addEventListener('click', () => ctx.select(id));
        list.appendChild(chip);
    }
    return list;
}

/** The Inspector: everything known about the selected node, with live editing for signals. */
export function renderInspector(ctx: PanelCtx, side: HTMLElement, onClose: () => void): void
{
    side.textContent = '';
    if (ctx.selectedId === null)
    {
        return;
    }
    const graph = ctx.graph();
    const node = graph.nodes.find((n) => n.id === ctx.selectedId);
    if (!node)
    {
        onClose();
        return;
    }

    const box = el('div', 'az-insp');

    const title = el('div', 'az-insp-title');
    const kind = el('span', 'az-kind', node.kind);
    kind.style.background = KIND_COLOR[node.kind] ?? '#8aa0b5';
    title.appendChild(kind);
    if (node.primitive !== undefined)
    {
        const prim = el('span', 'az-prim', node.primitive);
        prim.style.background = PRIMITIVE_COLOR[node.primitive] ?? '#8aa0b5';
        title.appendChild(prim);
    }
    const close = el('button', 'az-iconbtn', 'x');
    close.title = 'Close inspector (Esc)';
    close.addEventListener('click', onClose);
    title.append(el('span', 'az-insp-name az-mono', labelOf(node)), close);
    box.appendChild(title);

    // Source location - click opens the file in the editor via Vite's middleware.
    if (node.open !== '')
    {
        const link = el('button', 'az-link az-mono', node.loc || node.file);
        link.title = `Open ${ node.open } in your editor`;
        link.addEventListener('click', () => ctx.openInEditor(node.open));
        box.appendChild(fieldRow('source', link));
    }
    else
    {
        box.appendChild(fieldRow('source', el('span', 'az-fieldval az-mono', node.loc || node.file || '(unknown)')));
    }

    if (node.kind === 'signal' || node.kind === 'memo')
    {
        const peeked = ctx.peek(node.id);
        if (node.kind === 'signal' && ctx.live)
        {
            const edit = el('span', 'az-editrow');
            const input = el('input', 'az-input az-mono');
            input.value = peeked.ok ? peeked.value ?? '' : '';
            const apply = (): void =>
            {
                let value: unknown;
                try
                {
                    value = JSON.parse(input.value);
                }
                catch
                {
                    value = input.value;
                }
                ctx.agent.poke(node.id, value);
                ctx.rerender();
            };
            const set = el('button', 'az-btn', 'Set');
            set.addEventListener('click', apply);
            input.addEventListener('keydown', (e) =>
            {
                if (e.key === 'Enter')
                {
                    apply();
                }
            });
            edit.append(input, set);
            box.appendChild(fieldRow('value', edit));
        }
        else
        {
            box.appendChild(fieldRow('value', el('span', 'az-fieldval value az-mono', peeked.ok ? peeked.value ?? '' : '(uncomputed)')));
        }

        const hist = ctx.history(node.id);
        if (hist.length >= 2)
        {
            const holder = el('span', 'az-fieldval');
            holder.appendChild(sparkline(hist));
            box.appendChild(fieldRow('history', holder));
        }
    }

    box.appendChild(fieldRow(node.kind === 'signal' ? 'writes' : 'runs',
        el('span', 'az-fieldval', String(node.kind === 'signal' ? node.writes : node.runs))));

    // Group membership: the declared primitive this node belongs to, with sibling navigation.
    if (node.group !== undefined)
    {
        const siblings = graph.nodes.filter((n) => n.group === node.group && n.id !== node.id).map((n) => n.id);
        box.appendChild(fieldRow(node.primitive ?? 'group', chips(ctx, siblings, graph)));
    }

    const reads = graph.edges.filter((e) => e.to === node.id).map((e) => e.from);
    const usedBy = graph.edges.filter((e) => e.from === node.id).map((e) => e.to);
    box.appendChild(fieldRow('reads', chips(ctx, reads, graph)));
    box.appendChild(fieldRow('used by', chips(ctx, usedBy, graph)));

    side.appendChild(box);
}
