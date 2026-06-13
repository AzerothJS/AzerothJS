// In-page devtools panel: a live view of the reactive graph's activity,
// built from the devtools-hook events (created/disposed/run/write). It
// answers the questions developers actually ask a signals framework:
// what is alive right now, what keeps re-running, and which write
// triggered it.
//
// Install BEFORE mounting - nodes created earlier carry no devtools id and
// stay invisible (same ordering rule as the error overlay). The panel is
// plain DOM, framework-free, and repaints on a coalescing timer so a
// write-storm costs one render, not one per event.

import { setDevtoolsHook, type DevtoolsNode } from '@azerothjs/reactivity';

/** Tracked state per node. */
interface NodeStats
{
    id: number;
    kind: 'signal' | 'effect' | 'memo';
    name?: string;
    alive: boolean;
    runs: number;
    writes: number;
}

const PANEL_ID = 'azeroth-devtools';
const MAX_ROWS = 30;

/** @internal */
let active: { uninstall: () => void } | null = null;

/**
 * Installs the devtools panel: registers the reactivity hook and renders a
 * fixed panel summarizing live node counts and the most active nodes.
 * Idempotent; returns an uninstall function that removes the panel and
 * restores the previous hook.
 *
 * @example
 * ```ts
 * // Dev entry, BEFORE render():
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

    const nodes = new Map<number, NodeStats>();
    let lastWriter: NodeStats | null = null;
    let panel: HTMLElement | null = null;
    let renderQueued = false;

    function scheduleRender(): void
    {
        if (renderQueued)
        {
            return;
        }
        renderQueued = true;
        setTimeout(() =>
        {
            renderQueued = false;
            renderPanel();
        }, 100);
    }

    const unregisterHook = setDevtoolsHook({
        created(node: DevtoolsNode): void
        {
            nodes.set(node.id, { ...node, alive: true, runs: 0, writes: 0 });
            scheduleRender();
        },
        disposed(id: number): void
        {
            const stats = nodes.get(id);
            if (stats)
            {
                stats.alive = false;
            }
            scheduleRender();
        },
        run(id: number): void
        {
            const stats = nodes.get(id);
            if (stats)
            {
                stats.runs++;
            }
            scheduleRender();
        },
        write(id: number): void
        {
            const stats = nodes.get(id);
            if (stats)
            {
                stats.writes++;
                lastWriter = stats;
            }
            scheduleRender();
        }
    });

    function renderPanel(): void
    {
        if (panel === null)
        {
            panel = buildPanel();
            document.body.appendChild(panel);
        }

        const alive = [...nodes.values()].filter(n => n.alive);
        const count = (kind: NodeStats['kind']): number => alive.filter(n => n.kind === kind).length;

        const summary = panel.querySelector('[data-devtools-summary]') as HTMLElement;
        summary.textContent =
            `${ count('signal') } signals | ${ count('effect') } effects | ${ count('memo') } memos` +
            (lastWriter ? ` | last write: ${ label(lastWriter) }` : '');

        // Most active first; the busy nodes are the interesting ones.
        const rows = [...nodes.values()]
            .sort((a, b) => (b.runs + b.writes) - (a.runs + a.writes))
            .slice(0, MAX_ROWS);

        const list = panel.querySelector('[data-devtools-list]') as HTMLElement;
        list.textContent = '';
        for (const stats of rows)
        {
            const row = document.createElement('div');
            row.setAttribute('style', `display:flex;gap:8px;padding:1px 0;${ stats.alive ? '' : 'opacity:0.4' }`);

            const kind = document.createElement('span');
            kind.setAttribute('style', 'width:44px;color:#7fd4a8');
            kind.textContent = stats.kind;

            const name = document.createElement('span');
            name.setAttribute('style', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
            name.textContent = label(stats) + (stats.alive ? '' : ' (disposed)');

            const counters = document.createElement('span');
            counters.textContent = stats.kind === 'signal'
                ? `${ stats.writes } writes`
                : `${ stats.runs } runs`;

            row.append(kind, name, counters);
            list.appendChild(row);
        }
    }

    function label(stats: NodeStats): string
    {
        return stats.name ?? `#${ stats.id }`;
    }

    function uninstall(): void
    {
        if (active === null)
        {
            return;
        }
        active = null;
        unregisterHook();
        panel?.remove();
        panel = null;
        nodes.clear();
    }

    active = { uninstall };
    return uninstall;
}

/** @internal */
function buildPanel(): HTMLElement
{
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('style', [
        'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483646',
        'width:340px', 'max-height:50vh', 'overflow:auto',
        'background:#101a14', 'color:#d7ecdf',
        'font:11px/1.5 ui-monospace,Consolas,monospace',
        'border:1px solid #2c4a38', 'border-radius:4px', 'padding:8px'
    ].join(';'));

    const title = document.createElement('div');
    title.setAttribute('style', 'display:flex;align-items:center;gap:8px;margin-bottom:4px');

    const heading = document.createElement('strong');
    heading.textContent = 'AzerothJS devtools';

    const collapse = document.createElement('button');
    collapse.textContent = 'toggle';
    collapse.setAttribute('style', 'margin-left:auto;background:#2c4a38;color:#d7ecdf;border:0;padding:1px 8px;cursor:pointer;font:inherit');

    title.append(heading, collapse);

    const summary = document.createElement('div');
    summary.setAttribute('data-devtools-summary', '');
    summary.setAttribute('style', 'margin-bottom:6px;color:#7fd4a8');

    const list = document.createElement('div');
    list.setAttribute('data-devtools-list', '');

    collapse.addEventListener('click', () =>
    {
        list.style.display = list.style.display === 'none' ? '' : 'none';
    });

    panel.append(title, summary, list);
    return panel;
}
