// The panel's client for the server bridge: one WebSocket to `attachDevtools`' endpoint,
// holding the latest streamed session. The Server view renders that session through the same
// components/inspector machinery as the browser graph - this module is transport only.

import type { SessionSnapshot } from './agent.ts';

export type ServerLinkStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

/** The live server connection the Server view drives. */
export interface ServerLink
{
    status(): ServerLinkStatus;
    session(): SessionSnapshot | null;
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

    function setStatus(next: ServerLinkStatus): void
    {
        status = next;
        onChange();
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

    return {
        status: () => status,
        session: () => session,
        url: () => target,
        connect(url: string): void
        {
            teardown();
            target = url;
            session = null;
            try
            {
                socket = new WebSocket(url);
            }
            catch
            {
                setStatus('error');
                return;
            }
            setStatus('connecting');
            socket.onopen = (): void => setStatus('open');
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
            socket.onerror = (): void => setStatus('error');
            socket.onclose = (): void =>
            {
                if (status === 'open')
                {
                    setStatus('closed');
                }
                else if (status === 'connecting')
                {
                    setStatus('error');
                }
            };
        },
        disconnect(): void
        {
            teardown();
            session = null;
            setStatus('idle');
        },
        dispose(): void
        {
            teardown();
            session = null;
            status = 'idle';
        }
    };
}
