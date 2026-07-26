// The server-side devtools bridge: attaches a dev-only WebSocket endpoint to a Node server that
// streams the SERVER's reactive graph to the in-page panel. Requests are reactive roots in
// @azerothjs/http, so the same agent, session shape, and panel views that inspect a browser app
// inspect the server unchanged - the bridge is a transport, not a second devtools.
//
// Composition mirrors @azerothjs/ws (the plugin contract deliberately has no socket access):
//
//     const served = await serve(app, { port: 5200 });
//     attachDevtools(served.server);
//
// Logs and traces stay the logger's job; this streams graph structure and values only.

import type { IncomingMessage, Server } from 'node:http';
import { attachWebSockets, type ServerSocket } from '@azerothjs/ws';
import { createAgent } from './agent.ts';

/** Options for {@link attachDevtools}. */
export interface DevtoolsBridgeOptions
{
    /** The upgrade pathname (default `/__azeroth/devtools`). */
    path?: string;

    /**
     * Gate connecting browsers by Origin. The default allows non-browser clients (no Origin)
     * and pages served from localhost / 127.0.0.1 / [::1] on any port - the graph can carry
     * live application values, so a random website must not be able to read it through the
     * visitor's browser. Override for LAN-hosted dev setups.
     */
    verifyOrigin?: (origin: string | null, request: IncomingMessage) => boolean;

    /** Minimum gap between session pushes to a client, in ms (default 250). */
    intervalMs?: number;
}

function defaultVerifyOrigin(origin: string | null): boolean
{
    if (origin === null)
    {
        return true;
    }
    try
    {
        const host = new URL(origin).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    }
    catch
    {
        return false;
    }
}

/**
 * Attaches the devtools bridge to a Node server (the `server` a `serve()` handle exposes).
 * Dev-only by construction: throws under `NODE_ENV=production` so it cannot ship by accident.
 * Returns a detach function that closes every client, removes the endpoint, and uninstalls the
 * server-side agent.
 *
 * Install BEFORE the app handles traffic to capture every request root from the start.
 *
 * @example
 * ```ts
 * import { serve } from '@azerothjs/http/node';
 * import { attachDevtools } from '@azerothjs/devtools/server';
 *
 * const served = await serve(app, { port: 5200 });
 * if (process.env.NODE_ENV !== 'production')
 * {
 *     attachDevtools(served.server);
 * }
 * ```
 */
export function attachDevtools(server: Server, options: DevtoolsBridgeOptions = {}): () => void
{
    if (process.env.NODE_ENV === 'production')
    {
        throw new Error('attachDevtools is a development bridge and refuses to run with NODE_ENV=production.');
    }

    const path = options.path ?? '/__azeroth/devtools';
    const intervalMs = options.intervalMs ?? 250;
    const agent = createAgent();
    const clients = new Set<ServerSocket>();

    let lastSentAt = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;

    function broadcast(): void
    {
        if (clients.size === 0)
        {
            return;
        }
        lastSentAt = Date.now();
        const payload = JSON.stringify({ type: 'session', session: agent.exportSession() });
        for (const socket of clients)
        {
            socket.send(payload);
        }
    }

    // The agent already coalesces notifications; this adds a floor between pushes with a
    // trailing send, so a busy server streams at a steady cadence instead of per-flush.
    const unsubscribe = agent.subscribe(() =>
    {
        const wait = lastSentAt + intervalMs - Date.now();
        if (wait <= 0)
        {
            broadcast();
            return;
        }
        if (pending === null)
        {
            pending = setTimeout(() =>
            {
                pending = null;
                broadcast();
            }, wait);
            pending.unref();
        }
    });

    const detachWs = attachWebSockets(server, {
        path,
        verifyOrigin: options.verifyOrigin ?? defaultVerifyOrigin,
        onConnection(socket: ServerSocket): void
        {
            clients.add(socket);
            socket.onClose = (): void =>
            {
                clients.delete(socket);
            };
            socket.send(JSON.stringify({ type: 'session', session: agent.exportSession() }));
        }
    });

    return (): void =>
    {
        if (pending !== null)
        {
            clearTimeout(pending);
            pending = null;
        }
        unsubscribe();
        detachWs();
        clients.clear();
        agent.uninstall();
    };
}
