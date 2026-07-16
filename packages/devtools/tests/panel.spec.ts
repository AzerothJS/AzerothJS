// @vitest-environment happy-dom
//
// The in-page panel driven through its ONLY public entry, installDevtools(): mount
// (launcher + hidden panel), live badge counts fed by real reactive nodes through the
// versioned hook, expand/collapse, tab switching, and teardown. No internals are
// imported - what these tests see is what a user sees. The agent coalesces its
// notifications on a macrotask, so every reactive burst is followed by flush().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDevtools } from '@azerothjs/devtools';
import { createSignal, createEffect, createRoot, type DisposeFn } from '@azerothjs/reactivity';

let uninstall: (() => void) | null = null;

/** Waits out the agent's notify -> render pass (coalesced on a 100ms timer). */
function flush(): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, 150));
}

beforeEach(() =>
{
    // Reset the one key the panel persists; this happy-dom build exposes a partial
    // Storage, so tolerate whatever surface it has (the panel guards the same way).
    try
    {
        localStorage.removeItem('azeroth-devtools:ui');
    }
    catch
    {
        // No usable storage - the panel falls back to defaults.
    }
});

afterEach(() =>
{
    uninstall?.();
    uninstall = null;
});

function panelRoot(): HTMLElement | null
{
    return document.getElementById('azeroth-devtools');
}

/** Installs, creates a small live graph, waits for the first render; returns its disposer. */
async function installWithGraph(): Promise<DisposeFn>
{
    uninstall = installDevtools();
    let dispose: DisposeFn = () => undefined;
    createRoot((d) =>
    {
        dispose = d;
        const [n, setN] = createSignal(0, { name: 'counter' });
        createEffect(() =>
        {
            n();
        });
        createEffect(() =>
        {
            n();
        });
        setN(5);
    });
    await flush();
    return dispose;
}

describe('installDevtools - chrome lifecycle', () =>
{
    it('mounts the launcher (collapsed by default) once the agent renders', async () =>
    {
        const dispose = await installWithGraph();

        const root = panelRoot();
        expect(root).not.toBeNull();
        const launcher = root?.querySelector('[data-devtools-launcher]') as HTMLElement;
        const header = root?.querySelector('[data-devtools-header]') as HTMLElement;
        const panel = header.parentElement as HTMLElement;
        // Collapsed: the launcher shows, the panel is hidden.
        expect(launcher.style.display).not.toBe('none');
        expect(panel.style.display).toBe('none');
        dispose();
    });

    it('is idempotent: a second install returns the same uninstall', () =>
    {
        uninstall = installDevtools();
        const again = installDevtools();
        expect(again).toBe(uninstall);
    });

    it('uninstall removes the chrome from the document', async () =>
    {
        const dispose = await installWithGraph();
        expect(panelRoot()).not.toBeNull();
        uninstall?.();
        uninstall = null;
        expect(panelRoot()).toBeNull();
        dispose();
    });
});

describe('installDevtools - live rendering', () =>
{
    it('the badge shows the LIVE effect count from real reactive nodes', async () =>
    {
        const dispose = await installWithGraph();
        const badge = panelRoot()?.querySelector('[data-devtools-badge]') as HTMLElement;
        expect(badge.textContent).toBe('2');
        dispose();
    });

    it('clicking the launcher expands the panel; collapse shrinks it back', async () =>
    {
        const dispose = await installWithGraph();

        const root = panelRoot() as HTMLElement;
        const launcher = root.querySelector('[data-devtools-launcher]') as HTMLElement;
        launcher.click();

        const header = root.querySelector('[data-devtools-header]') as HTMLElement;
        const panel = header.parentElement as HTMLElement;
        expect(panel.style.display).not.toBe('none');
        expect(launcher.style.display).toBe('none');

        const collapse = [...header.querySelectorAll('button')].find((b) => b.textContent === '-') as HTMLElement;
        collapse.click();
        expect(panel.style.display).toBe('none');
        expect(launcher.style.display).not.toBe('none');
        dispose();
    });

    it('tab clicks switch the active tab content (timeline lists the write)', async () =>
    {
        const dispose = await installWithGraph();

        const root = panelRoot() as HTMLElement;
        (root.querySelector('[data-devtools-launcher]') as HTMLElement).click();

        const timelineTab = root.querySelector('[data-devtools-tab="timeline"]') as HTMLElement;
        timelineTab.click();
        const content = root.querySelector('[data-devtools-content]') as HTMLElement;
        expect(content.textContent).toContain('write');
        dispose();
    });
});
