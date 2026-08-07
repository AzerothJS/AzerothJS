// @vitest-environment happy-dom
//
// The in-page panel driven through its ONLY public entry, installDevtools(): mount
// (launcher + hidden panel), live badge counts fed by real reactive nodes through the
// versioned hook, expand/collapse, tab switching, and teardown. No internals are
// imported - what these tests see is what a user sees. The agent coalesces its
// notifications on a macrotask, so every reactive burst is followed by flush().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDevtools } from '@azerothjs/devtools';
import { createSignal, createEffect, createRoot, createResource, type DisposeFn } from 'azerothjs';

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

// The panel mounts inside a shadow root (isolating it from host page CSS), so its content is
// reached through the host's shadowRoot, not the host's light DOM. Returns null once the host
// is removed on uninstall - which is exactly what the teardown test asserts.
function panelRoot(): HTMLElement | null
{
    const host = document.getElementById('azeroth-devtools');
    return (host?.shadowRoot?.querySelector('[data-devtools-root]') as HTMLElement | null) ?? null;
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

    it('the launcher and header carry the inline logo mark, not text stand-ins', async () =>
    {
        const dispose = await installWithGraph();

        const root = panelRoot();
        const launcherMark = root?.querySelector('[data-devtools-launcher] img') as HTMLImageElement;
        const headerMark = root?.querySelector('[data-devtools-header] .az-mark') as HTMLImageElement;

        expect(launcherMark.src.startsWith('data:image/png;base64,')).toBe(true);
        expect(headerMark.tagName).toBe('IMG');
        expect(headerMark.src.startsWith('data:image/png;base64,')).toBe(true);
        // The brand still NAMES the framework; the image replaces only the glyph.
        expect(root?.querySelector('[data-devtools-header]')?.textContent).toContain('AzerothJS');
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

    it('a declared primitive renders as ONE named group, not an anonymous pile of internals', async () =>
    {
        uninstall = installDevtools();
        let dispose: DisposeFn = () => undefined;
        createRoot((d) =>
        {
            dispose = d;
            createResource(() => Promise.resolve(1), { name: 'user' });
        });
        await flush();

        const root = panelRoot() as HTMLElement;
        (root.querySelector('[data-devtools-launcher]') as HTMLElement).click();
        await flush();

        const content = root.querySelector('[data-devtools-content]') as HTMLElement;
        const groupHead = content.querySelector('.az-grouphead') as HTMLElement;
        expect(groupHead).not.toBeNull();
        expect(groupHead.textContent).toContain('resource');
        expect(groupHead.textContent).toContain('user');
        // Members are collapsed until the group is opened.
        expect(content.querySelectorAll('.az-member').length).toBe(0);
        groupHead.click();
        const members = [...(root.querySelector('[data-devtools-content]') as HTMLElement).querySelectorAll('.az-member')];
        expect(members.length).toBeGreaterThanOrEqual(3);
        expect(members.map((m) => m.textContent).join(' ')).toContain('data');
        dispose();
    });

    it('the Server tab teaches how to enable the bridge when none is connected', async () =>
    {
        const dispose = await installWithGraph();
        const root = panelRoot() as HTMLElement;
        (root.querySelector('[data-devtools-launcher]') as HTMLElement).click();
        (root.querySelector('[data-devtools-tab="server"]') as HTMLElement).click();
        const content = root.querySelector('[data-devtools-content]') as HTMLElement;
        expect(content.textContent).toContain('Server inspection');
        expect(content.textContent).toContain('attachDevtools');
        dispose();
    });
});

describe('installDevtools - persisted-state hardening', () =>
{
    it('garbage persisted UI state degrades to a usable panel, never an off-screen sliver', async () =>
    {
        try
        {
            localStorage.setItem('azeroth-devtools:ui', JSON.stringify({
                collapsed: false,
                dock: 'sideways',
                view: 'bogus',
                floatLeft: -9999,
                floatTop: 123456,
                floatW: -50,
                floatH: 1,
                dockSize: 'huge'
            }));
        }
        catch
        {
            return; // No storage in this environment - nothing to harden against.
        }

        const dispose = await installWithGraph();
        const root = panelRoot() as HTMLElement;
        const panel = (root.querySelector('[data-devtools-header]') as HTMLElement).parentElement as HTMLElement;
        // Open (collapsed=false honored), with every number clamped to the minimums.
        expect(panel.style.display).not.toBe('none');
        expect(parseInt(panel.style.width, 10)).toBeGreaterThanOrEqual(300);
        expect(parseInt(panel.style.height, 10)).toBeGreaterThanOrEqual(220);
        // The components view (the fallback for the unknown view id) is active.
        const active = root.querySelector('[data-devtools-tab="components"]') as HTMLElement;
        expect(active.classList.contains('on')).toBe(true);
        dispose();
    });

    // A stored bridge URL without a token predates the tokenless-URL guard. It can never
    // connect (attachDevtools refuses the upgrade), so keeping it poisons every later
    // session on the origin: the invariant is that a tokenless URL is never attempted AND
    // never persisted. These seed the Server tab open so the auto-connect path runs at mount.
    describe('the stored bridge URL invariant', () =>
    {
        const SERVER_URL_KEY = 'azeroth-devtools:server-url';
        const SERVER_VIEW = JSON.stringify({ collapsed: false, dock: 'float', view: 'server', floatLeft: null, floatTop: null, floatW: 374, floatH: 520, dockSize: 380 });

        class RecordingSocket
        {
            public static urls: string[] = [];

            public static last: RecordingSocket | null = null;

            public onopen: (() => void) | null = null;

            public onmessage: (() => void) | null = null;

            public onerror: (() => void) | null = null;

            public onclose: (() => void) | null = null;

            constructor(url: string)
            {
                RecordingSocket.urls.push(url);
                RecordingSocket.last = this;
            }

            public close(): void
            {
                // The panel only ever calls this; nothing observes the result.
            }
        }

        let realSocket: unknown;

        beforeEach(() =>
        {
            RecordingSocket.urls = [];
            RecordingSocket.last = null;
            realSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
            (globalThis as { WebSocket?: unknown }).WebSocket = RecordingSocket;
        });

        afterEach(() =>
        {
            (globalThis as { WebSocket?: unknown }).WebSocket = realSocket;
            try
            {
                localStorage.removeItem(SERVER_URL_KEY);
            }
            catch
            {
                // No storage - nothing to clean.
            }
        });

        it('a legacy tokenless stored URL is purged, never attempted', async () =>
        {
            try
            {
                localStorage.setItem(SERVER_URL_KEY, 'ws://localhost:3000/__azeroth/devtools');
                localStorage.setItem('azeroth-devtools:ui', SERVER_VIEW);
            }
            catch
            {
                return;
            }
            const dispose = await installWithGraph();
            await flush();
            expect(RecordingSocket.urls).toEqual([]);
            expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
            dispose();
        });

        it('a tokenful stored URL survives and connects', async () =>
        {
            const target = 'ws://localhost:3000/__azeroth/devtools?token=0123456789abcdef';
            try
            {
                localStorage.setItem(SERVER_URL_KEY, target);
                localStorage.setItem('azeroth-devtools:ui', SERVER_VIEW);
            }
            catch
            {
                return;
            }
            const dispose = await installWithGraph();
            await flush();
            expect(RecordingSocket.urls).toEqual([target]);
            expect(localStorage.getItem(SERVER_URL_KEY)).toBe(target);
            dispose();
        });

        it('a stored URL that never opens is forgotten, so the next load is clean', async () =>
        {
            // This key is per-ORIGIN and every vite project shares localhost:5173, so a token
            // left by the previous project made each new one open with a 403 in its console -
            // on every load, because nothing ever cleared it. Reproduced in a real browser
            // before this fix: one attempt per load, forever.
            const stale = 'ws://localhost:3000/__azeroth/devtools?token=stale-token-from-old-project';
            try
            {
                localStorage.setItem(SERVER_URL_KEY, stale);
                localStorage.setItem('azeroth-devtools:ui', SERVER_VIEW);
            }
            catch
            {
                return;
            }
            const dispose = await installWithGraph();
            await flush();
            expect(RecordingSocket.urls).toEqual([stale]); // it is tried once...

            // ...the socket closes without ever opening, which is terminal for a url that
            // never worked. The panel must not carry it into the next session.
            const socket = RecordingSocket.last;
            socket?.onclose?.();
            await flush();
            expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
            dispose();
        });
    });
});

describe('direction independence', () =>
{
    it('renders left-to-right inside an RTL page', async () =>
    {
        // `all: initial` on :host does NOT reset direction - the CSS spec excludes it - so
        // an RTL application used to mirror the whole panel. The labels are English and the
        // values are code; the tool reads LTR whatever it is inspecting.
        document.documentElement.setAttribute('dir', 'rtl');
        try
        {
            const dispose = await installWithGraph();
            const style = panelRoot()?.getRootNode() as ShadowRoot | undefined;
            const css = style?.querySelector('style')?.textContent ?? '';

            expect(css).toContain('direction: ltr');
            // Pinned on the shadow HOST rule, so every node inside inherits it.
            expect(/:host\s*\{[^}]*direction:\s*ltr/.test(css)).toBe(true);
            dispose();
        }
        finally
        {
            document.documentElement.removeAttribute('dir');
        }
    });
});
