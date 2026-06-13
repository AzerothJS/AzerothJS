// Dev-only error overlay: an in-page panel for the errors that otherwise
// die in the console. Installed once at startup (the Vite plugin injects it
// in serve mode), it catches:
//
//   - uncaught REACTIVE errors via onUncaughtError - an effect or memo
//     whose run threw with no catchError/ErrorBoundary scope. These carry
//     the node kind and the effect's debug name when one was given.
//   - window 'error' and 'unhandledrejection' - event handlers and async
//     code, which run outside any reactive scope.
//
// The panel is plain DOM, deliberately framework-free: an overlay that
// renders through the framework cannot report the framework's own failures.
// Stack traces are shown as the browser reports them - open the entry in
// devtools for source-mapped frames (Vite serves the maps).

import { onUncaughtError, type UncaughtErrorContext } from '@azerothjs/reactivity';

/** One captured error. */
interface OverlayEntry
{
    title: string;
    message: string;
    stack: string;
}

const PANEL_ID = 'azeroth-error-overlay';

/** @internal */
let active: { uninstall: () => void } | null = null;

/**
 * Installs the overlay: registers the reactive last-resort handler and the
 * window listeners, and renders the panel on the first error. Idempotent -
 * a second call returns the active installation's uninstall.
 *
 * @returns Uninstall function: removes listeners and the panel.
 *
 * @example
 * ```ts
 * // Entry point, dev builds only (the Vite plugin does this for you):
 * import { installOverlay } from '@azerothjs/devtools-overlay';
 * installOverlay();
 * ```
 */
export function installOverlay(): () => void
{
    if (active !== null)
    {
        return active.uninstall;
    }

    const entries: OverlayEntry[] = [];
    let panel: HTMLElement | null = null;

    function push(entry: OverlayEntry): void
    {
        entries.push(entry);
        renderPanel();
    }

    const unregisterReactive = onUncaughtError((error: unknown, context: UncaughtErrorContext) =>
    {
        const err = toError(error);
        const where = context.name ? `${ context.source } "${ context.name }"` : context.source;
        push({
            title: `Uncaught reactive error in ${ where }`,
            message: err.message,
            stack: err.stack ?? ''
        });
    });

    const onWindowError = (event: ErrorEvent): void =>
    {
        const err = toError(event.error ?? event.message);
        push({ title: 'Uncaught error', message: err.message, stack: err.stack ?? '' });
    };

    const onRejection = (event: PromiseRejectionEvent): void =>
    {
        const err = toError(event.reason);
        push({ title: 'Unhandled promise rejection', message: err.message, stack: err.stack ?? '' });
    };

    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onRejection);

    function renderPanel(): void
    {
        if (panel === null)
        {
            panel = buildPanel(() =>
            {
                entries.length = 0;
                panel?.remove();
                panel = null;
            });
            document.body.appendChild(panel);
        }

        const list = panel.querySelector('[data-overlay-list]') as HTMLElement;
        list.textContent = '';
        for (const entry of entries)
        {
            list.appendChild(buildEntry(entry));
        }
        const count = panel.querySelector('[data-overlay-count]') as HTMLElement;
        count.textContent = String(entries.length);
    }

    function uninstall(): void
    {
        if (active === null)
        {
            return;
        }
        active = null;
        unregisterReactive();
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onRejection);
        panel?.remove();
        panel = null;
        entries.length = 0;
    }

    active = { uninstall };
    return uninstall;
}

/** @internal */
function toError(value: unknown): Error
{
    return value instanceof Error ? value : new Error(String(value));
}

/** @internal */
function buildPanel(dismiss: () => void): HTMLElement
{
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('style', [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'max-height:45vh', 'overflow:auto',
        'background:#1c1017', 'color:#f3d9e3',
        'font:12px/1.5 ui-monospace,Consolas,monospace',
        'border-top:2px solid #e0457b', 'padding:0'
    ].join(';'));

    const bar = document.createElement('div');
    bar.setAttribute('style', 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:#2a1620;position:sticky;top:0');

    const label = document.createElement('strong');
    label.textContent = 'AzerothJS dev overlay - ';
    const count = document.createElement('span');
    count.setAttribute('data-overlay-count', '');
    count.textContent = '0';
    const suffix = document.createElement('span');
    suffix.textContent = ' error(s). Scoped handling: catchError() / <ErrorBoundary>.';

    const dismissButton = document.createElement('button');
    dismissButton.textContent = 'dismiss';
    dismissButton.setAttribute('style', 'margin-left:auto;background:#e0457b;color:#fff;border:0;padding:2px 10px;cursor:pointer;font:inherit');
    dismissButton.addEventListener('click', dismiss);

    bar.append(label, count, suffix, dismissButton);

    const list = document.createElement('div');
    list.setAttribute('data-overlay-list', '');

    panel.append(bar, list);
    return panel;
}

/** @internal */
function buildEntry(entry: OverlayEntry): HTMLElement
{
    const wrap = document.createElement('div');
    wrap.setAttribute('style', 'padding:8px 12px;border-bottom:1px solid #3a2230');

    const title = document.createElement('div');
    title.setAttribute('style', 'color:#ff7daa;font-weight:bold');
    title.textContent = entry.title;

    const message = document.createElement('div');
    message.textContent = entry.message;

    wrap.append(title, message);

    if (entry.stack)
    {
        const stack = document.createElement('pre');
        stack.setAttribute('style', 'margin:6px 0 0;white-space:pre-wrap;color:#b08aa0');
        stack.textContent = entry.stack;
        wrap.appendChild(stack);
    }

    return wrap;
}
