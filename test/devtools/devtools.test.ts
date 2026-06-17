// The in-page devtools panel (the shell over the agent): renders the active
// tab from the agent's model, prunes on dispose, docks/resizes, and
// uninstalls back to pristine.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDevtools } from '@azerothjs/devtools';
import { createSignal, createEffect } from '@azerothjs/reactivity';

let uninstall: (() => void) | null = null;

afterEach(() =>
{
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
    // Dock/size/collapsed state persists across reloads via localStorage;
    // clear it so each test starts from the documented default (collapsed).
    try
    {
        localStorage.clear();
    }
    catch
    { /* ignore */ }
});

function panel(): HTMLElement | null
{
    return document.getElementById('azeroth-devtools');
}

function launcherEl(): HTMLElement | null
{
    return document.querySelector('#azeroth-devtools [data-devtools-launcher]');
}

function panelEl(): HTMLElement | null
{
    return document.querySelector('#azeroth-devtools [data-devtools-panel]');
}

function summaryText(): string
{
    return panelEl()!.querySelector('[data-devtools-summary]')!.textContent!;
}

function contentText(): string
{
    return panelEl()!.querySelector('[data-devtools-content]')!.textContent!;
}

function tab(id: string): HTMLElement
{
    return panelEl()!.querySelector(`[data-devtools-tab="${ id }"]`)!;
}

function expand(): void
{
    launcherEl()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('installDevtools', () =>
{
    it('renders live counts, activity, and the last writer', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();

        const [count, setCount] = createSignal(0, { name: 'count' });
        const dispose = createEffect(() =>
        {
            count();
        }, { name: 'count-binding' });

        setCount(1);
        setCount(2);

        vi.advanceTimersByTime(150);
        expect(panel()).not.toBeNull();
        expand();

        const summary = summaryText();
        expect(summary).toContain('1 sig');
        expect(summary).toContain('1 eff');
        expect(summary).toContain('last: count');

        // Default tab is Tree: the effect row shows its run count.
        const list = contentText();
        expect(list).toContain('count-binding');
        expect(list).toContain('3 r');   // initial + 2 writes

        dispose();
        vi.advanceTimersByTime(150);
        expect(summaryText()).toContain('0 eff');
        // Disposed nodes are pruned, so the current view stays clean.
        expect(contentText()).not.toContain('count-binding');
    });

    it('prunes disposed nodes so a page switch shows the new page, not stale rows', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();

        const [a, setA] = createSignal(0);
        const old = createEffect(() =>
        {
            a();
        }, { name: 'old-page-effect' });
        setA(1);
        setA(2);
        setA(3);
        vi.advanceTimersByTime(150);
        expand();
        expect(contentText()).toContain('old-page-effect');

        // "navigate": the old page disposes, the new page mounts fresh.
        old();
        const fresh = createEffect(() =>
        {
            // a brand-new, zero-activity effect
        }, { name: 'new-page-effect' });
        vi.advanceTimersByTime(150);

        const list = contentText();
        expect(list).not.toContain('old-page-effect');  // pruned on dispose
        expect(list).toContain('new-page-effect');       // visible immediately
        fresh();
    });

    it('coalesces a write storm into one render pass', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();

        const [, setN] = createSignal(0, { name: 'n' });
        for (let i = 1; i <= 100; i++)
        {
            setN(i);
        }

        // Nothing rendered yet - the panel waits out the coalescing window.
        expect(panel()).toBeNull();

        vi.advanceTimersByTime(150);
        expect(panel()).not.toBeNull();
        expand();
        expect(contentText()).toContain('100 w');
    });

    it('is idempotent and uninstall removes the panel and the hook', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        expect(installDevtools()).toBe(uninstall);

        createSignal(0, { name: 'x' });
        vi.advanceTimersByTime(150);
        expect(panel()).not.toBeNull();

        uninstall();
        uninstall = null;
        expect(panel()).toBeNull();
    });

    it('starts collapsed as a launcher icon (does not cover the app)', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'a' });
        vi.advanceTimersByTime(150);

        // Launcher shown, full panel hidden by default.
        expect(launcherEl()!.style.display).not.toBe('none');
        expect(panelEl()!.style.display).toBe('none');
    });

    it('the launcher badge shows the live effect count', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [v] = createSignal(0);
        const d1 = createEffect(() =>
        {
            v();
        });
        const d2 = createEffect(() =>
        {
            v();
        });
        vi.advanceTimersByTime(150);

        const badge = document.querySelector('#azeroth-devtools [data-devtools-badge]')!;
        expect(badge.textContent).toBe('2');

        d1();
        vi.advanceTimersByTime(150);
        expect(badge.textContent).toBe('1');

        d2();
    });

    it('opens the inspector on row click and edits a signal value', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [n] = createSignal(5, { name: 'counter' });
        createEffect(() =>
        {
            n();
        }, { name: 'reader' });
        vi.advanceTimersByTime(150);
        expand();

        const detail = panelEl()!.querySelector('[data-devtools-detail]') as HTMLElement;
        expect(detail.style.display).toBe('none'); // nothing selected yet

        // Click the signal row in the Tree.
        const rows = [...panelEl()!.querySelectorAll('[data-devtools-content] div')];
        const sigRow = rows.find((r) => r.textContent!.includes('counter = 5'))!;
        sigRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // Inspector shows the value and who reads it.
        expect(detail.style.display).toBe('block');
        expect(detail.textContent).toContain('counter');
        expect(detail.textContent).toContain('used by');

        // Edit the value via the inspector input.
        const input = detail.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('5');
        input.value = '42';
        const setBtn = [...detail.querySelectorAll('button')].find((b) => b.textContent === 'Set')!;
        setBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // The new value is reflected in the Tree row.
        expect(contentText()).toContain('counter = 42');
    });

    it('navigates rows with arrow keys and closes the inspector with Escape', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'first' });
        createSignal(0, { name: 'second' });
        vi.advanceTimersByTime(150);
        expand();

        // Pretend the pointer is over the panel so arrow keys are claimed.
        panelEl()!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const detail = panelEl()!.querySelector('[data-devtools-detail]') as HTMLElement;
        expect(detail.style.display).toBe('none');

        // ArrowDown selects the first row.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(detail.style.display).toBe('block');
        const firstSel = detail.textContent;

        // ArrowDown again moves to the next row.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(detail.textContent).not.toBe(firstSel);

        // Escape closes the inspector.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(detail.style.display).toBe('none');
    });

    it('shows a value-history sparkline in the inspector', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [, setN] = createSignal(0, { name: 'metric' });
        setN(5);
        setN(9);
        vi.advanceTimersByTime(150);
        expand();

        const rows = [...panelEl()!.querySelectorAll('[data-devtools-content] div')];
        rows.find((r) => r.textContent!.includes('metric'))!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        const detail = panelEl()!.querySelector('[data-devtools-detail]') as HTMLElement;
        expect(detail.textContent).toContain('history');
        expect(detail.querySelector('svg polyline')).not.toBeNull();
    });

    it('imports a session snapshot and renders it read-only', async () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'live-signal' });
        vi.advanceTimersByTime(150);
        expand();

        const snap = {
            version: 1,
            model: {
                nodes: [{ id: 1, kind: 'signal', name: 'imported-sig', owner: 0, file: 'app.ts', loc: 'app.ts:1', open: '', runs: 0, writes: 3 }],
                counts: { signal: 1, effect: 0, memo: 0, root: 0 },
                lastWrite: { id: 1, name: 'imported-sig' }
            },
            graph: { nodes: [{ id: 1, kind: 'signal', name: 'imported-sig', owner: 0, file: 'app.ts', loc: 'app.ts:1', open: '', runs: 0, writes: 3 }], edges: [] },
            timeline: [{ t: 0, type: 'write', id: 1, kind: 'signal', name: 'imported-sig' }],
            health: { kinds: [], leaks: [] },
            values: { 1: '99' },
            histories: { 1: [10, 50, 99] }
        };

        tab('settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const input = panelEl()!.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File([JSON.stringify(snap)], 'session.json', { type: 'application/json' });
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await vi.runAllTimersAsync();

        // Renders the imported graph, not the live one, with a banner.
        expect(contentText()).toContain('Viewing imported snapshot');
        expect(contentText()).toContain('imported-sig');
        expect(contentText()).not.toContain('live-signal');

        // Inspect the imported signal: value is shown but NOT editable.
        const rows = [...panelEl()!.querySelectorAll('[data-devtools-content] div')];
        rows.find((r) => r.textContent!.includes('imported-sig'))!
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const detail = panelEl()!.querySelector('[data-devtools-detail]') as HTMLElement;
        expect(detail.textContent).toContain('99');
        expect(detail.querySelector('input')).toBeNull(); // read-only
        expect(detail.querySelector('svg polyline')).not.toBeNull(); // history survived
    });

    it('jumps to a node inspector via search + Enter', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'apple' });
        createSignal(0, { name: 'banana' });
        vi.advanceTimersByTime(150);
        expand();

        const input = panelEl()!.querySelector('input') as HTMLInputElement;
        input.value = 'banana';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        const detail = panelEl()!.querySelector('[data-devtools-detail]') as HTMLElement;
        expect(detail.style.display).toBe('block');
        expect(detail.textContent).toContain('banana');
    });

    it('pauses and clears the timeline from the toolbar', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [, setN] = createSignal(0, { name: 'tick' });
        setN(1);
        vi.advanceTimersByTime(150);
        expand();
        tab('timeline').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // Pause via the toolbar toggle.
        const toggle = [...panelEl()!.querySelectorAll('[data-devtools-content] button')]
            .find((b) => b.textContent!.includes('Recording'))!;
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(contentText()).toContain('Paused');

        // Frozen: new writes do not grow the stream.
        const before = panelEl()!.querySelectorAll('[data-devtools-content] > div').length;
        setN(2);
        setN(3);
        vi.advanceTimersByTime(150);
        expect(panelEl()!.querySelectorAll('[data-devtools-content] > div').length).toBe(before);

        // Clear empties it.
        const clear = [...panelEl()!.querySelectorAll('[data-devtools-content] button')]
            .find((b) => b.textContent === 'Clear')!;
        clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(contentText()).toContain('0 events');
    });

    it('draws a dependency diagram for the selected node in the Graph tab', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [price] = createSignal(10, { name: 'price' });
        createEffect(() =>
        {
            price();
        }, { name: 'total' });
        vi.advanceTimersByTime(150);
        expand();

        // Select the effect, then open the Graph tab.
        const rows = [...panelEl()!.querySelectorAll('[data-devtools-content] div')];
        const effRow = rows.find((r) => /^effect/.test(r.textContent!.trim()) && r.textContent!.includes('total'))!;
        effRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        tab('graph').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // The neighborhood diagram is an inline SVG; it should name the producer.
        const svg = panelEl()!.querySelector('[data-devtools-content] svg');
        expect(svg).not.toBeNull();
        expect(svg!.textContent).toContain('price');
    });

    it('switches tabs (Tree -> Timeline)', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        const [, setN] = createSignal(0, { name: 'ticker' });
        setN(1);
        vi.advanceTimersByTime(150);
        expand();

        tab('timeline').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // The Timeline lists the write event for the named signal.
        expect(contentText()).toContain('write');
        expect(contentText()).toContain('ticker');
    });

    it('docks to an edge and resizes the docked panel', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'a' });
        vi.advanceTimersByTime(150);
        expand();

        tab('settings').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const buttons = panelEl()!.querySelectorAll('[data-devtools-content] button');
        const leftBtn = [...buttons].find((b) => b.textContent === 'left')!;
        leftBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // Docked left: pinned to the left edge, full viewport height.
        expect(panelEl()!.style.height).toBe('100vh');
        expect(panel()!.style.right).toBe('auto');
    });

    it('filters the node list by name', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'apple' });
        createSignal(0, { name: 'banana' });
        vi.advanceTimersByTime(150);
        expand();

        const input = panelEl()!.querySelector('input') as HTMLInputElement;
        input.value = 'app';
        input.dispatchEvent(new Event('input'));

        const list = contentText();
        expect(list).toContain('apple');
        expect(list).not.toContain('banana');
    });

    it('expands on launcher click and collapses via the panel button', () =>
    {
        vi.useFakeTimers();
        uninstall = installDevtools();
        createSignal(0, { name: 'a' });
        vi.advanceTimersByTime(150);

        // Clicking the launcher expands the panel.
        expand();
        expect(panelEl()!.style.display).toBe('flex');
        expect(launcherEl()!.style.display).toBe('none');

        // The collapse button (the only button in the header) returns it to the icon.
        const collapse = panelEl()!.querySelector('[data-devtools-header] button')!;
        collapse.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(panelEl()!.style.display).toBe('none');
        expect(launcherEl()!.style.display).not.toBe('none');
    });
});
