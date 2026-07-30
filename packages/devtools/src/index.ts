// The in-page devtools panel: a plain-DOM shell over the agent (agent.ts), which is the only
// code that touches the framework. The panel renders the agent's model/graph/timeline and never
// observes itself: it is deliberately NOT built with AzerothJS (the observer must not perturb
// the graph it inspects).
//
// Chrome: a draggable launcher pill (live effect-count badge) that expands into the inspector -
// an icon rail (Components, Timeline, Graph, Performance, Server, Settings), a search-first
// toolbar (Ctrl+K), a master-detail body, and an inspector pane that sits right on a wide panel
// and bottom on a narrow one. The panel FLOATS (drag + corner-resize) or DOCKS to an edge, and
// every restore path is clamped so no persisted state can produce an off-screen or zero-size
// panel. Everything lives inside a shadow root so host CSS can never reach in.
//
// Install BEFORE mounting so nodes created earlier are captured. Dev-only; tree-shaken from
// production builds.

import {
    createAgent,
    type AgentModel,
    type AgentGraph,
    type AgentHealth,
    type TimelineEntry,
    type SessionSnapshot
} from './agent.ts';
import { el, icon } from './dom.ts';
import { buildStyle } from './theme.ts';
import {
    renderComponents,
    renderTimeline,
    renderGraph,
    renderPerf,
    renderInspector,
    renderServer,
    scrollToSelected,
    type PanelCtx
} from './views.ts';
import { createServerLink, bridgeUrl } from './server-client.ts';

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
    AgentRequest,
    DevtoolsPrimitive
} from './agent.ts';

const PANEL_ID = 'azeroth-devtools';
const UI_KEY = 'azeroth-devtools:ui';

type Dock = 'float' | 'left' | 'right' | 'bottom';
type View = 'components' | 'timeline' | 'graph' | 'perf' | 'server' | 'settings';

const DOCKS: readonly Dock[] = ['float', 'left', 'right', 'bottom'];
const VIEW_IDS: readonly View[] = ['components', 'timeline', 'graph', 'perf', 'server', 'settings'];

/** Icon rail entries (lucide-style stroke paths, inlined - the panel has no dependencies). */
const VIEWS: { id: View; title: string; d: string }[] = [
    { id: 'components', title: 'Components', d: 'm12 2-10 5 10 5 10-5-10-5Z M2 12l10 5 10-5 M2 17l10 5 10-5' },
    { id: 'timeline', title: 'Timeline', d: 'M12 6v6l4 2 M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Z' },
    { id: 'graph', title: 'Graph', d: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4' },
    { id: 'perf', title: 'Performance', d: 'M22 12h-4l-3 9L9 3l-3 9H2' },
    { id: 'server', title: 'Server', d: 'M2 4h20v6H2Z M2 14h20v6H2Z M6 7h.01 M6 17h.01' },
    { id: 'settings', title: 'Settings', d: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6' }
];

interface UiState
{
    collapsed: boolean;
    dock: Dock;
    view: View;
    floatLeft: number | null;
    floatTop: number | null;
    floatW: number;
    floatH: number;
    dockSize: number;
}

const DEFAULT_UI: UiState = {
    collapsed: true,
    dock: 'float',
    view: 'components',
    floatLeft: null,
    floatTop: null,
    floatW: 460,
    floatH: 520,
    dockSize: 380
};

const MIN_W = 300;
const MIN_H = 220;
const MIN_DOCK = 240;

/**
 * Validates and clamps a persisted UI state. Garbage (an unknown dock, a NaN size, a float
 * position saved on a larger monitor) degrades to a usable value instead of an invisible panel.
 */
function sanitizeUi(raw: unknown): UiState
{
    const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof UiState, unknown>>;
    const num = (v: unknown, fallback: number, min: number, max: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const floatW = num(r.floatW, DEFAULT_UI.floatW, MIN_W, Math.max(MIN_W, vw - 16));
    const floatH = num(r.floatH, DEFAULT_UI.floatH, MIN_H, Math.max(MIN_H, vh - 16));
    const hasPos = typeof r.floatLeft === 'number' && Number.isFinite(r.floatLeft)
        && typeof r.floatTop === 'number' && Number.isFinite(r.floatTop);

    return {
        collapsed: typeof r.collapsed === 'boolean' ? r.collapsed : DEFAULT_UI.collapsed,
        dock: DOCKS.includes(r.dock as Dock) ? r.dock as Dock : DEFAULT_UI.dock,
        view: VIEW_IDS.includes(r.view as View) ? r.view as View : DEFAULT_UI.view,
        floatLeft: hasPos ? Math.min(Math.max(r.floatLeft as number, 0), Math.max(0, vw - 60)) : null,
        floatTop: hasPos ? Math.min(Math.max(r.floatTop as number, 0), Math.max(0, vh - 40)) : null,
        floatW,
        floatH,
        dockSize: num(r.dockSize, DEFAULT_UI.dockSize, MIN_DOCK, Math.max(MIN_DOCK, Math.max(vw, vh) - 16))
    };
}

function loadUi(): UiState
{
    try
    {
        const raw = localStorage.getItem(UI_KEY);
        if (raw !== null)
        {
            return sanitizeUi(JSON.parse(raw));
        }
    }
    catch
    {
        // localStorage unavailable or corrupt - use defaults.
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

const SERVER_URL_KEY = 'azeroth-devtools:server-url';

/** Options for {@link installDevtools}. */
export interface InstallOptions
{
    /**
     * The backend to inspect in the Server tab: an http(s) API base
     * (`import.meta.env.VITE_API_URL`) or a full ws URL, including the bridge's
     * `?token=...` - `attachDevtools` refuses an upgrade without it. The tab connects on
     * first open; a URL entered in the tab wins over this.
     */
    server?: string;
}

/** @internal */
let active: { uninstall: () => void } | null = null;

/**
 * Installs the devtools panel (and its agent). Idempotent; returns an
 * uninstall function that removes the panel and detaches the agent.
 *
 * @example
 * ```ts
 * import { installDevtools } from '@azerothjs/devtools';
 * installDevtools({ server: import.meta.env.VITE_API_URL });
 * ```
 */
export function installDevtools(options: InstallOptions = {}): () => void
{
    if (active !== null)
    {
        return active.uninstall;
    }

    const agent = createAgent();
    const ui = loadUi();
    let selectedId: number | null = null;
    let pointerInPanel = false;
    // When an exported session is imported, the panel renders from it (read only).
    let snapshot: SessionSnapshot | null = null;

    /** The mounted chrome, built once by mount(). */
    interface PanelDom
    {
        host: HTMLElement;
        root: HTMLElement;
        launcher: HTMLElement;
        badge: HTMLElement;
        panel: HTMLElement;
        summary: HTMLElement;
        search: HTMLInputElement;
        main: HTMLElement;
        sideRight: HTMLElement;
        sideBottom: HTMLElement;
    }
    let dom: PanelDom | null = null;

    const ctx: PanelCtx = {
        agent,
        live: true,
        filter: '',
        selectedId: null,
        navOrder: [],
        openGroups: new Set<number>(),
        openBursts: new Set<number>(),
        model(): AgentModel
        {
            return snapshot ? snapshot.model : agent.getModel();
        },
        graph(): AgentGraph
        {
            return snapshot ? snapshot.graph : agent.getGraph();
        },
        timeline(): TimelineEntry[]
        {
            return snapshot ? snapshot.timeline : agent.getTimeline();
        },
        health(): AgentHealth
        {
            return snapshot ? snapshot.health : agent.getHealth();
        },
        history(id: number): number[]
        {
            return snapshot ? (snapshot.histories[id] ?? []) : agent.getHistory(id);
        },
        peek(id: number): { ok: boolean; value?: string }
        {
            if (snapshot)
            {
                const v = snapshot.values[id];
                return v !== undefined ? { ok: true, value: v } : { ok: false };
            }
            return agent.peek(id);
        },
        select(id: number): void
        {
            selectedId = selectedId === id ? null : id;
            render();
        },
        openInEditor(open: string): void
        {
            if (open !== '')
            {
                // Vite's /__open-in-editor middleware; a production preview just fails silently.
                void fetch(`/__open-in-editor?file=${ encodeURIComponent(open) }`).catch(() => undefined);
            }
        },
        rerender(): void
        {
            render();
        }
    };

    // The agent already coalesces its notifications, so render directly.
    const unsubscribe = agent.subscribe(() => render());
    const justDragged = new WeakSet<HTMLElement>();

    // --- server bridge ---------------------------------------------------

    // Deferred: a status change can fire synchronously from connect() DURING a render pass
    // (the Server tab's first-open auto-connect); rendering re-entrantly would double the view.
    const serverLink = createServerLink(() =>
    {
        if (!ui.collapsed && ui.view === 'server')
        {
            setTimeout(() => render(), 0);
        }
    });
    let serverAutoTried = false;

    function savedServerUrl(): string
    {
        try
        {
            return localStorage.getItem(SERVER_URL_KEY) ?? '';
        }
        catch
        {
            return '';
        }
    }

    const EMPTY_MODEL: AgentModel = { nodes: [], counts: { signal: 0, effect: 0, memo: 0, root: 0 }, lastWrite: null };
    const EMPTY_GRAPH: AgentGraph = { nodes: [], edges: [] };

    /** The Server tab's view context: the same panel machinery, sourced from the streamed session. */
    const serverCtx: PanelCtx = {
        agent,
        live: false,
        filter: '',
        selectedId: null,
        navOrder: [],
        openGroups: new Set<number>(),
        openBursts: new Set<number>(),
        model: () => serverLink.session()?.model ?? EMPTY_MODEL,
        graph: () => serverLink.session()?.graph ?? EMPTY_GRAPH,
        timeline: () => serverLink.session()?.timeline ?? [],
        health: () => serverLink.session()?.health ?? { kinds: [], leaks: [] },
        history: (id) => serverLink.session()?.histories[id] ?? [],
        peek(id): { ok: boolean; value?: string }
        {
            const v = serverLink.session()?.values[id];
            return v !== undefined ? { ok: true, value: v } : { ok: false };
        },
        select(id: number): void
        {
            selectedId = selectedId === id ? null : id;
            render();
        },
        openInEditor(): void
        {
            // Server files are outside the frontend dev server's editor middleware.
        },
        rerender(): void
        {
            render();
        }
    };

    /** The context the active view reads: the server mirror on the Server tab, the page otherwise. */
    function activeCtx(): PanelCtx
    {
        return ui.view === 'server' && serverLink.session() !== null ? serverCtx : ctx;
    }

    // --- rendering -------------------------------------------------------

    function render(): void
    {
        const d = dom ?? mount();
        ctx.live = snapshot === null;
        ctx.selectedId = selectedId;

        const model = ctx.model();
        d.badge.textContent = String(model.counts.effect);
        d.summary.textContent =
            `${ model.counts.signal } sig | ${ model.counts.effect } eff | ${ model.counts.memo } memo`
            + (model.lastWrite ? ` | last: ${ model.lastWrite.name }` : '');

        if (ui.collapsed)
        {
            return;
        }

        d.main.textContent = '';
        ctx.navOrder = [];

        if (snapshot)
        {
            const banner = el('div', 'az-banner');
            const label = el('span', 'az-spacer', 'Viewing imported snapshot (read only)');
            const back = el('button', 'az-btn', 'Return to live');
            back.addEventListener('click', () =>
            {
                snapshot = null;
                selectedId = null;
                render();
            });
            banner.append(label, back);
            d.main.appendChild(banner);
        }

        switch (ui.view)
        {
            case 'components':
                renderComponents(ctx, d.main);
                break;
            case 'timeline':
                renderTimeline(ctx, d.main);
                break;
            case 'graph':
                renderGraph(ctx, d.main);
                break;
            case 'perf':
                renderPerf(ctx, d.main);
                break;
            case 'server':
                renderServerView(d.main);
                break;
            case 'settings':
                renderSettings(d.main);
                break;
        }

        // Inspector placement adapts to the panel's width: a right pane when there is room,
        // a bottom drawer otherwise. The Server tab inspects the streamed server graph.
        const wide = d.panel.clientWidth >= 560;
        const side = wide ? d.sideRight : d.sideBottom;
        const other = wide ? d.sideBottom : d.sideRight;
        other.style.display = 'none';
        other.textContent = '';
        if (selectedId === null)
        {
            side.style.display = 'none';
            side.textContent = '';
        }
        else
        {
            side.style.display = 'block';
            if (wide)
            {
                side.style.width = `${ Math.min(320, Math.floor(d.panel.clientWidth * 0.42)) }px`;
            }
            else
            {
                side.style.maxHeight = '45%';
            }
            renderInspector(activeCtx(), side, () =>
            {
                selectedId = null;
                render();
            });
        }
    }

    /** The Server tab: connection bar + the server's components tree, mirrored live. */
    function renderServerView(main: HTMLElement): void
    {
        const status = serverLink.status();

        // First open: try the configured backend (or the last manually-used URL) once.
        if (!serverAutoTried && status === 'idle')
        {
            serverAutoTried = true;
            const initial = savedServerUrl() || (options.server !== undefined ? bridgeUrl(options.server) : '');
            if (initial !== '')
            {
                serverLink.connect(initial);
            }
        }

        const bar = el('div', 'az-toolbar');
        const url = el('input', 'az-search az-mono');
        url.placeholder = 'ws://localhost:5200/__azeroth/devtools?token=...';
        url.value = serverLink.url() || savedServerUrl() || (options.server !== undefined ? bridgeUrl(options.server) : '');
        url.addEventListener('pointerdown', (e) => e.stopPropagation());
        const connect = (): void =>
        {
            const target = bridgeUrl(url.value);
            if (target === '')
            {
                return;
            }
            try
            {
                localStorage.setItem(SERVER_URL_KEY, target);
            }
            catch
            {
                // Non-fatal.
            }
            serverLink.connect(target);
            render();
        };
        url.addEventListener('keydown', (e) =>
        {
            if (e.key === 'Enter')
            {
                connect();
            }
        });
        const action = el('button', 'az-btn', serverLink.status() === 'open' ? 'Disconnect' : 'Connect');
        action.addEventListener('click', () =>
        {
            if (serverLink.status() === 'open')
            {
                serverLink.disconnect();
                selectedId = null;
                render();
            }
            else
            {
                connect();
            }
        });
        const dot = el('span', `az-status ${ status === 'open' ? 'ok' : status === 'connecting' ? 'warn' : status === 'idle' ? '' : 'err' }`,
            status === 'idle' ? 'off' : status);
        bar.append(url, action, dot);
        main.appendChild(bar);

        const session = serverLink.session();
        if (status === 'open' && session !== null)
        {
            serverCtx.filter = ctx.filter;
            serverCtx.selectedId = selectedId;
            renderComponents(serverCtx, main);
            return;
        }
        renderServer(ctx, main);
    }

    /** Settings: dock, pop-out, session export/import, and the shortcut list. */
    function renderSettings(main: HTMLElement): void
    {
        main.onscroll = null;
        ctx.navOrder = [];

        main.appendChild(el('div', 'az-section', 'Dock'));
        const dockRow = el('div', 'az-legend');
        dockRow.style.display = 'flex';
        dockRow.style.gap = '5px';
        for (const dock of DOCKS)
        {
            const b = el('button', `az-btn${ ui.dock === dock ? ' on' : '' }`, dock);
            b.addEventListener('click', () =>
            {
                ui.dock = dock;
                saveUi(ui);
                applyLayout();
                render();
            });
            dockRow.appendChild(b);
        }
        const pop = el('button', 'az-btn', 'pop out');
        pop.addEventListener('click', popOut);
        dockRow.appendChild(pop);
        main.appendChild(dockRow);

        main.appendChild(el('div', 'az-section', 'Session'));
        const sessionRow = el('div', 'az-legend');
        sessionRow.style.display = 'flex';
        sessionRow.style.gap = '5px';
        const exportBtn = el('button', 'az-btn', 'export JSON');
        exportBtn.title = 'Download the full model/graph/timeline for a bug report';
        exportBtn.addEventListener('click', () =>
        {
            const json = JSON.stringify(agent.exportSession(), null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'azeroth-devtools-session.json';
            a.click();
            URL.revokeObjectURL(url);
        });
        const importBtn = el('button', 'az-btn', 'import');
        const fileInput = el('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        fileInput.style.display = 'none';
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
        if (snapshot)
        {
            const back = el('button', 'az-btn on', 'return to live');
            back.addEventListener('click', () =>
            {
                snapshot = null;
                selectedId = null;
                render();
            });
            sessionRow.appendChild(back);
        }
        main.appendChild(sessionRow);

        main.appendChild(el('div', 'az-section', 'Shortcuts'));
        for (const [keys, what] of [
            ['Ctrl+K', 'focus the filter'],
            ['Up / Down', 'move the selection'],
            ['Enter (in filter)', 'inspect the first match'],
            ['Esc', 'close the inspector']
        ])
        {
            main.appendChild(el('div', 'az-hint', `${ keys }  -  ${ what }`));
        }

        main.appendChild(el('div', 'az-section', 'Tips'));
        main.appendChild(el('div', 'az-hint',
            'Declared keyword names label everything automatically on the dev server. In plain TS, pass { name } to createSignal/createResource/createForm for the same labels.'));
    }

    async function loadSnapshotFile(file: File): Promise<void>
    {
        try
        {
            const parsed = JSON.parse(await file.text()) as Partial<SessionSnapshot> | null;
            if (!parsed || typeof parsed !== 'object' || !parsed.model || !parsed.graph)
            {
                return;
            }
            snapshot = parsed as SessionSnapshot;
            selectedId = null;
            setView('components');
        }
        catch
        {
            // Malformed file - ignore.
        }
    }

    function setView(view: View): void
    {
        // Node ids are per-graph: a selection cannot survive the page <-> server boundary.
        if ((view === 'server') !== (ui.view === 'server'))
        {
            selectedId = null;
        }
        ui.view = view;
        saveUi(ui);
        const d = dom;
        if (d !== null)
        {
            for (const v of VIEWS)
            {
                const b = d.panel.querySelector(`[data-devtools-tab="${ v.id }"]`);
                b?.classList.toggle('on', v.id === view);
            }
        }
        render();
    }

    // --- keyboard --------------------------------------------------------

    function onKeyDown(e: KeyboardEvent): void
    {
        if (ui.collapsed || dom === null)
        {
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'))
        {
            dom.search.focus();
            dom.search.select();
            e.preventDefault();
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
        // Only claim the arrows while the user is working in the panel.
        if (!pointerInPanel && selectedId === null)
        {
            return;
        }
        const order = activeCtx().navOrder;
        if (order.length === 0)
        {
            return;
        }
        const idx = selectedId === null ? -1 : order.indexOf(selectedId);
        const nextIdx = e.key === 'ArrowDown'
            ? Math.min(idx + 1, order.length - 1)
            : Math.max(idx - 1, 0);
        const next = order[nextIdx < 0 ? 0 : nextIdx];
        if (next !== undefined)
        {
            selectedId = next;
            render();
            scrollSelectedIntoView();
            e.preventDefault();
        }
    }

    function scrollSelectedIntoView(): void
    {
        const d = dom;
        if (d === null || selectedId === null)
        {
            return;
        }
        if (ui.view === 'components' || (ui.view === 'server' && serverLink.session() !== null))
        {
            const vctx = activeCtx();
            vctx.selectedId = selectedId;
            scrollToSelected(vctx, d.main);
            return;
        }
        d.main.querySelector(`[data-node-id="${ selectedId }"]`)?.scrollIntoView({ block: 'nearest' });
    }

    // --- chrome ----------------------------------------------------------

    function mount(): PanelDom
    {
        // The panel lives inside a SHADOW ROOT, not the light DOM. This fully isolates it from
        // the host page: the app's CSS (a Tailwind preflight `*{}` reset, global rules, a theme)
        // cannot reach across the shadow boundary, and the panel's styles never leak out.
        // Without this the panel inherits host styles and renders broken (a stray white strip at
        // the window edge). A single host element carries the id for external reference.
        const host = document.createElement('div');
        host.id = PANEL_ID;
        // Inert host: out of normal flow at zero size so it can never shift the app's layout.
        host.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.appendChild(buildStyle());

        const root = el('div', 'az-root');
        root.setAttribute('data-devtools-root', '');

        const launcher = buildLauncher();
        const built = buildPanel();
        dom = { host, root, launcher, badge: launcher.querySelector('[data-devtools-badge]') as HTMLElement, ...built };

        root.append(launcher, built.panel);
        shadow.appendChild(root);
        document.body.appendChild(host);

        built.panel.addEventListener('mouseenter', () =>
        {
            pointerInPanel = true;
        });
        built.panel.addEventListener('mouseleave', () =>
        {
            pointerInPanel = false;
        });
        document.addEventListener('keydown', onKeyDown);

        applyLayout();
        return dom;
    }

    function buildLauncher(): HTMLElement
    {
        const pill = el('button', 'az-launcher');
        pill.setAttribute('data-devtools-launcher', '');
        pill.title = 'AzerothJS devtools - click to open, drag to move';
        const mark = el('span', '', 'AZ');
        const badge = el('span', 'az-badge', '0');
        badge.setAttribute('data-devtools-badge', '');
        pill.append(mark, badge);

        pill.addEventListener('click', () =>
        {
            if (justDragged.has(pill))
            {
                justDragged.delete(pill);
                return;
            }
            ui.collapsed = false;
            saveUi(ui);
            applyLayout();
            render();
        });
        makeDraggable(pill, true);
        return pill;
    }

    function buildPanel(): Omit<PanelDom, 'host' | 'root' | 'launcher' | 'badge'>
    {
        const panel = el('div', 'az-panel');
        panel.setAttribute('data-devtools-panel', '');

        // Header: brand, live summary, collapse. The drag handle when floating.
        const header = el('div', 'az-header');
        header.setAttribute('data-devtools-header', '');
        const brand = el('strong', 'az-brand');
        const markSpan = el('span', 'az-mark', '▲');
        brand.append(markSpan, document.createTextNode('AzerothJS'));
        const summary = el('span', 'az-summary');
        summary.setAttribute('data-devtools-summary', '');
        const collapse = el('button', 'az-iconbtn', '-');
        collapse.title = 'Collapse to icon';
        collapse.addEventListener('pointerdown', (e) => e.stopPropagation());
        collapse.addEventListener('click', (e) =>
        {
            e.stopPropagation();
            ui.collapsed = true;
            saveUi(ui);
            applyLayout();
        });
        header.append(brand, summary, collapse);

        // Toolbar: the one always-visible filter.
        const toolbar = el('div', 'az-toolbar');
        const search = el('input', 'az-search');
        search.placeholder = 'Filter by name, primitive, kind, or file';
        search.addEventListener('pointerdown', (e) => e.stopPropagation());
        search.addEventListener('input', () =>
        {
            ctx.filter = search.value;
            render();
        });
        search.addEventListener('keydown', (e) =>
        {
            if (e.key !== 'Enter')
            {
                return;
            }
            const f = search.value.toLowerCase();
            const hit = ctx.model().nodes.find((n) => n.kind !== 'root'
                && ((n.name ?? '').toLowerCase().includes(f) || (n.groupName ?? '').toLowerCase().includes(f) || n.file.toLowerCase().includes(f)));
            if (hit)
            {
                selectedId = hit.id;
                render();
                scrollSelectedIntoView();
            }
        });
        const kbd = el('span', 'az-kbd', 'Ctrl K');
        toolbar.append(search, kbd);

        // Body: icon rail | main | right inspector.
        const body = el('div', 'az-body');
        const rail = el('div', 'az-rail');
        for (const v of VIEWS)
        {
            const b = el('button', `az-railbtn${ ui.view === v.id ? ' on' : '' }`);
            b.setAttribute('data-devtools-tab', v.id);
            b.title = v.title;
            b.appendChild(icon(v.d));
            b.addEventListener('pointerdown', (e) => e.stopPropagation());
            b.addEventListener('click', (e) =>
            {
                e.stopPropagation();
                setView(v.id);
            });
            rail.appendChild(b);
        }

        const main = el('div', 'az-main');
        main.setAttribute('data-devtools-content', '');
        const sideRight = el('div', 'az-side');
        sideRight.setAttribute('data-devtools-detail', '');
        sideRight.style.display = 'none';
        body.append(rail, main, sideRight);

        const sideBottom = el('div', 'az-side bottom');
        sideBottom.style.display = 'none';

        panel.append(header, toolbar, body, sideBottom);

        // Resize handle (repositioned per dock mode by applyLayout).
        const handle = el('div', 'az-resize');
        handle.setAttribute('data-devtools-resize', '');
        panel.appendChild(handle);
        makeResizable(handle);

        makeDraggable(header, false);
        return { panel, summary, search, main, sideRight, sideBottom };
    }

    // --- layout (dock / float / collapse / resize) -----------------------

    function applyLayout(): void
    {
        const d = dom;
        if (d === null)
        {
            return;
        }
        d.launcher.style.display = ui.collapsed ? 'flex' : 'none';
        d.panel.style.display = ui.collapsed ? 'none' : 'flex';

        const handle = d.panel.querySelector('[data-devtools-resize]') as HTMLElement;
        const header = d.panel.querySelector('[data-devtools-header]') as HTMLElement;

        if (ui.collapsed)
        {
            placeFloating();
            return;
        }

        // Re-clamp against the CURRENT viewport: it may have shrunk since the state was saved.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        ui.floatW = Math.min(Math.max(ui.floatW, MIN_W), Math.max(MIN_W, vw - 16));
        ui.floatH = Math.min(Math.max(ui.floatH, MIN_H), Math.max(MIN_H, vh - 16));

        if (ui.dock === 'float')
        {
            if (ui.floatLeft !== null && ui.floatTop !== null)
            {
                ui.floatLeft = Math.min(Math.max(ui.floatLeft, 0), Math.max(0, vw - ui.floatW));
                ui.floatTop = Math.min(Math.max(ui.floatTop, 0), Math.max(0, vh - 40));
            }
            placeFloating();
            d.panel.style.width = `${ ui.floatW }px`;
            d.panel.style.height = `${ ui.floatH }px`;
            header.style.cursor = 'grab';
            handle.style.cssText = 'position:absolute;background:transparent;z-index:1;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize';
            return;
        }

        // Docked: pin to an edge, full span on the cross axis.
        ui.dockSize = Math.min(Math.max(ui.dockSize, MIN_DOCK), Math.max(MIN_DOCK, (ui.dock === 'bottom' ? vh : vw) - 16));
        header.style.cursor = 'default';
        d.root.style.left = ui.dock === 'right' ? 'auto' : '0';
        d.root.style.right = ui.dock === 'right' ? '0' : 'auto';
        d.root.style.top = ui.dock === 'bottom' ? 'auto' : '0';
        d.root.style.bottom = ui.dock === 'bottom' ? '0' : 'auto';

        if (ui.dock === 'bottom')
        {
            d.panel.style.width = '100vw';
            d.panel.style.height = `${ ui.dockSize }px`;
            handle.style.cssText = 'position:absolute;background:transparent;z-index:1;left:0;top:0;width:100%;height:6px;cursor:ns-resize';
        }
        else
        {
            d.panel.style.width = `${ ui.dockSize }px`;
            d.panel.style.height = '100vh';
            handle.style.cssText = `position:absolute;background:transparent;z-index:1;${ ui.dock === 'right' ? 'left' : 'right' }:0;top:0;width:6px;height:100%;cursor:ew-resize`;
        }
    }

    function placeFloating(): void
    {
        const d = dom;
        if (d === null)
        {
            return;
        }
        if (ui.floatLeft !== null && ui.floatTop !== null)
        {
            d.root.style.left = `${ ui.floatLeft }px`;
            d.root.style.top = `${ ui.floatTop }px`;
            d.root.style.right = 'auto';
            d.root.style.bottom = 'auto';
        }
        else
        {
            d.root.style.right = '12px';
            d.root.style.bottom = '12px';
            d.root.style.left = 'auto';
            d.root.style.top = 'auto';
        }
    }

    function makeDraggable(handle: HTMLElement, isLauncher: boolean): void
    {
        handle.addEventListener('pointerdown', (down: PointerEvent) =>
        {
            const d = dom;
            if (down.button !== 0 || d === null || (!isLauncher && ui.dock !== 'float'))
            {
                return;
            }
            const rect = d.root.getBoundingClientRect();
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
                d.root.style.left = `${ left }px`;
                d.root.style.top = `${ top }px`;
                d.root.style.right = 'auto';
                d.root.style.bottom = 'auto';
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
                    const r = d.root.getBoundingClientRect();
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
            if (down.button !== 0 || dom === null)
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
                    ui.floatW = Math.max(MIN_W, Math.min(startW + (e.clientX - startX), window.innerWidth - 20));
                    ui.floatH = Math.max(MIN_H, Math.min(startH + (e.clientY - startY), window.innerHeight - 20));
                }
                else if (ui.dock === 'bottom')
                {
                    ui.dockSize = Math.max(MIN_DOCK, Math.min(startH - (e.clientY - startY), window.innerHeight - 20));
                }
                else if (ui.dock === 'left')
                {
                    ui.dockSize = Math.max(MIN_DOCK, Math.min(startW + (e.clientX - startX), window.innerWidth - 20));
                }
                else
                {
                    ui.dockSize = Math.max(MIN_DOCK, Math.min(startW - (e.clientX - startX), window.innerWidth - 20));
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
                render();
            };
            handle.addEventListener('pointermove', move);
            handle.addEventListener('pointerup', up);
        });
    }

    // --- pop-out ---------------------------------------------------------

    function popOut(): void
    {
        const win = window.open('', 'azeroth-devtools', 'width=460,height=580');
        if (!win)
        {
            return;
        }
        win.document.title = 'AzerothJS devtools';
        win.document.body.style.cssText = 'margin:0;background:#0e141b;color:#d5e1ec;font:12px/1.5 ui-monospace,Consolas,monospace';
        const pre = win.document.createElement('pre');
        pre.style.cssText = 'padding:10px;white-space:pre-wrap';
        win.document.body.appendChild(pre);

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
                const v = (n.kind === 'signal' || n.kind === 'memo') ? agent.peek(n.id) : { ok: false as const };
                const label = n.groupName !== undefined ? `${ n.groupName }.${ n.name ?? n.id }` : n.name ?? `#${ n.id }`;
                lines.push(`${ n.kind.padEnd(6) } ${ label.padEnd(24) } ${ v.ok ? `= ${ 'value' in v ? v.value : '' }` : '' }  ${ n.file }`);
            }
            pre.textContent = lines.join('\n');
        };
        const timer = win.setInterval(tick, 400);
        tick();
    }

    function uninstall(): void
    {
        if (active === null)
        {
            return;
        }
        active = null;
        unsubscribe();
        serverLink.dispose();
        document.removeEventListener('keydown', onKeyDown);
        agent.uninstall();
        dom?.host.remove();
        dom = null;
    }

    active = { uninstall };
    return uninstall;
}
