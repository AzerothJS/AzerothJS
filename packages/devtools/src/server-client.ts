// The panel's client for the server bridge: one WebSocket to `attachDevtools`' endpoint,
// holding the latest streamed session. The Server view renders that session through the same
// components/inspector machinery as the browser graph - this module is transport only.

import type { SessionSnapshot } from './agent.ts';

export type ServerLinkStatus = 'idle' | 'connecting' | 'retrying' | 'open' | 'error' | 'closed';

/** The live server connection the Server view drives. */
export interface ServerLink
{
    status(): ServerLinkStatus;
    session(): SessionSnapshot | null;

    /**
     * Whether the current url has EVER opened. It is what separates "the dev server
     * restarted" from "this url is wrong": the browser never learns why an upgrade failed,
     * so a proven-good url is the only evidence a retry is worth making.
     */
    everOpened(): boolean;

    /** The endpoint currently targeted (ws URL), or ''. */
    url(): string;
    connect(url: string): void;
    disconnect(): void;
    dispose(): void;
}

/**
 * Normalizes what a user (or `installDevtools({ server })`) provides into the bridge's ws URL:
 * an http(s) API base becomes ws(s) + the bridge path; a ws(s) URL passes through (default
 * path appended when none is present).
 */
export function bridgeUrl(base: string): string
{
    const trimmed = base.trim().replace(/\/$/, '');
    if (trimmed === '')
    {
        return '';
    }
    const withScheme = trimmed.replace(/^http/, 'ws');
    const hasPath = /^wss?:\/\/[^/]+\/./.test(withScheme);
    return hasPath ? withScheme : `${ withScheme }/__azeroth/devtools`;
}

/** Creates the (single) server link; `onChange` fires on any status or session change. */
export function createServerLink(onChange: () => void): ServerLink
{
    let socket: WebSocket | null = null;
    let status: ServerLinkStatus = 'idle';
    let session: SessionSnapshot | null = null;
    let target = '';

    // Reconnection rests on ONE fact: whether this url ever opened. An upgrade that was
    // accepted proves the token, the path and the origin are all good, so a later drop is
    // the dev server restarting - retry it. A url that never opened is a wrong token, a
    // wrong address, or a bridge that is not attached; retrying that would spin forever and
    // hide the mistake behind a spinner, so it fails loudly instead.
    //
    // The browser cannot tell these apart from the socket alone: a refused upgrade never
    // becomes a WebSocket, and `onerror` carries no status. This history is the only signal
    // available, and it lives here because the link is what outlives the restart.
    let everOpened = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    // Bounded on purpose: a restart is seconds, so this spans one comfortably, and a server
    // that stays down (or a token changed under us) settles into a state the panel explains
    // rather than an endless loop.
    const MAX_ATTEMPTS = 10;
    const FIRST_DELAY_MS = 300;
    const MAX_DELAY_MS = 5000;

    function setStatus(next: ServerLinkStatus): void
    {
        status = next;
        onChange();
    }

    function clearTimer(): void
    {
        if (timer !== null)
        {
            clearTimeout(timer);
            timer = null;
        }
    }

    /** Schedules the next attempt, or gives up with a status the panel can explain. */
    function scheduleRetry(): void
    {
        if (disposed || !everOpened)
        {
            setStatus('error');
            return;
        }
        if (attempt >= MAX_ATTEMPTS)
        {
            setStatus('error');
            return;
        }
        const delay = Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        attempt++;
        setStatus('retrying');
        clearTimer();
        timer = setTimeout(() => open(target), delay);
    }

    function teardown(): void
    {
        if (socket !== null)
        {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            socket = null;
        }
    }

    /** Opens one socket at `url`; every attempt - first or retry - comes through here. */
    function open(url: string): void
    {
        teardown();
        session = null;
        try
        {
            socket = new WebSocket(url);
        }
        catch
        {
            scheduleRetry();
            return;
        }
        setStatus('connecting');
        socket.onopen = (): void =>
        {
            // The url is proven: this is what licenses a retry after a later drop.
            everOpened = true;
            attempt = 0;
            setStatus('open');
        };
        socket.onmessage = (e: MessageEvent): void =>
        {
            try
            {
                const parsed = JSON.parse(String(e.data)) as { type?: string; session?: SessionSnapshot };
                if (parsed.type === 'session' && parsed.session !== undefined)
                {
                    session = parsed.session;
                    onChange();
                }
            }
            catch
            {
                // Not the bridge's payload - ignore.
            }
        };
        // A refused upgrade fires error THEN close, and a dropped connection fires close
        // alone, so the decision is made in one place: close.
        socket.onerror = (): void => undefined;
        socket.onclose = (): void =>
        {
            if (disposed)
            {
                return;
            }
            scheduleRetry();
        };
    }

    return {
        status: () => status,
        everOpened: () => everOpened,
        session: () => session,
        url: () => target,
        connect(url: string): void
        {
            // A manual connect is the escape hatch: it clears the retry budget and the
            // proven-good history, so a corrected url starts from a clean slate.
            clearTimer();
            everOpened = false;
            attempt = 0;
            disposed = false;
            target = url;
            open(url);
        },
        disconnect(): void
        {
            clearTimer();
            everOpened = false;
            attempt = 0;
            teardown();
            session = null;
            setStatus('idle');
        },
        dispose(): void
        {
            disposed = true;
            clearTimer();
            teardown();
            session = null;
            status = 'idle';
        }
    };
}
