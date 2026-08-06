// The server-side devtools bridge: attaches a dev-only WebSocket endpoint to a Node server that
// streams the SERVER's reactive graph to the in-page panel. Requests are reactive roots in
// @azerothjs/http, so the same agent, session shape, and panel views that inspect a browser app
// inspect the server unchanged - the bridge is a transport, not a second devtools.
//
// What it streams IS live application state - a request root's signals hold whatever that request
// is carrying, tokens and account rows included - so the endpoint is gated four ways, all of them
// positive: an explicit development environment, a shared secret on the upgrade, a loopback peer,
// and a known Origin. There is no inbound command surface: the bridge never assigns onMessage.
//
// Composition mirrors @azerothjs/ws (the plugin contract deliberately has no socket access):
//
//     const served = await serve(app, { port: 5200 });
//     attachDevtools(served.server, { token: process.env.DEVTOOLS_TOKEN });
//
// Logs and traces stay the logger's job; this streams graph structure and values only.

import type { IncomingMessage, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { attachWebSockets, type ServerSocket } from '@azerothjs/ws';
import { createAgent } from './agent.ts';

/** Options for {@link attachDevtools}. */
export interface DevtoolsBridgeOptions
{
    /**
     * The shared secret every upgrade must present as `?token=...` on the endpoint URL
     * (`ws://localhost:5200/__azeroth/devtools?token=...`). REQUIRED, at least 16 characters:
     * the graph carries live request state, and a browser cannot set headers on a WebSocket,
     * so the query string is the one place a panel can prove it was invited. Generate one per
     * process with `crypto.randomUUID()`.
     */
    token: string;

    /** The upgrade pathname (default `/__azeroth/devtools`). */
    path?: string;

    /**
     * Gate connecting browsers by Origin. The default allows pages served from
     * localhost / 127.0.0.1 / [::1] on any port and REFUSES a missing Origin - a browser
     * cannot forge one, and a client that sends none is not the panel. Override for
     * LAN-hosted dev setups.
     */
    verifyOrigin?: (origin: string | null, request: IncomingMessage) => boolean;

    /**
     * Attach even when `NODE_ENV` is not exactly `development`. The environment check is
     * POSITIVE by design: "not production" also means unset, `staging`, `Production`, and
     * `production ` - every one of which would have exposed the graph. Set this only for a
     * deliberate non-standard dev setup.
     */
    allowNonDevelopment?: boolean;

    /**
     * Accept upgrades whose peer address is not loopback (a container, a LAN dev machine).
     * Default false: the panel runs on the developer's own machine.
     */
    allowRemoteClients?: boolean;

    /** Minimum gap between session pushes to a client, in ms (default 250). */
    intervalMs?: number;
}

/** @internal The shortest secret worth calling one. */
const MIN_TOKEN_LENGTH = 16;

function defaultVerifyOrigin(origin: string | null): boolean
{
    // A non-browser client (no Origin at all) is refused: it is exactly what a plain socket
    // sends, and the panel is always a page.
    if (origin === null)
    {
        return false;
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

/** @internal The loopback peers: IPv4, IPv6, and the IPv4-mapped form Node reports on dual sockets. */
function isLoopback(address: string | undefined): boolean
{
    return address !== undefined
        && (address.startsWith('127.') || address === '::1' || address === '::ffff:127.0.0.1');
}

/** @internal Length-first constant-time compare; a mismatch must not leak where it happened. */
function secretMatches(expected: string, presented: string | null): boolean
{
    if (presented === null || presented.length !== expected.length)
    {
        return false;
    }
    return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
}

/**
 * Attaches the devtools bridge to a Node server (the `server` a `serve()` handle exposes).
 * Dev-only by construction: it throws unless `NODE_ENV` is exactly `development` (or
 * `allowNonDevelopment` is set), and every upgrade must come from a loopback peer, carry the
 * shared `token` in the query string, and pass the Origin check - the stream is live
 * application state, so the perimeter is never a single header. Returns a detach function that
 * closes every client, removes the endpoint, and uninstalls the server-side agent.
 *
 * Install BEFORE the app handles traffic to capture every request root from the start.
 *
 * The token must OUTLIVE the process. A dev server restarts on every file save, so a token
 * minted at boot (`crypto.randomUUID()`) is a different secret each time: the panel holds the
 * previous one and every restart refuses it with a 403. Read it from the environment, where
 * it survives restarts and both halves can agree on it.
 *
 * @example
 * ```ts
 * import { serve } from '@azerothjs/http/node';
 * import { attachDevtools } from '@azerothjs/devtools/server';
 *
 * const served = await serve(app, { port: 5200 });
 * const token = process.env.DEVTOOLS_TOKEN;
 * if (process.env.NODE_ENV === 'development' && token !== undefined)
 * {
 *     attachDevtools(served.server, { token });
 *     console.log(`devtools: ws://localhost:5200/__azeroth/devtools?token=${ token }`);
 * }
 * ```
 */
export function attachDevtools(server: Server, options: DevtoolsBridgeOptions): () => void
{
    if (options.allowNonDevelopment !== true && process.env.NODE_ENV !== 'development')
    {
        throw new Error('attachDevtools is a development bridge: it attaches only with NODE_ENV=development '
            + '(pass allowNonDevelopment for a deliberate non-standard dev setup).');
    }
    // The cast keeps the guard REAL: a JS caller (or a call site written against the older
    // one-argument form) arrives with no token at all, and types cannot stop that.
    if (typeof (options.token as unknown) !== 'string' || options.token.length < MIN_TOKEN_LENGTH)
    {
        throw new Error(`attachDevtools needs a shared secret of at least ${ MIN_TOKEN_LENGTH } characters `
            + '- attachDevtools(server, { token: crypto.randomUUID() }) - because the bridge streams live application state.');
    }

    const path = options.path ?? '/__azeroth/devtools';
    const intervalMs = options.intervalMs ?? 250;
    const token = options.token;
    const verifyOrigin = options.verifyOrigin ?? defaultVerifyOrigin;
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
        // ws calls this before the handshake and answers a false with 403 over the raw
        // socket, which is the whole gate: peer, secret, then Origin. Nothing about the
        // connection is trusted until all three hold.
        verifyOrigin(origin: string | null, request: IncomingMessage): boolean
        {
            if (options.allowRemoteClients !== true && !isLoopback(request.socket.remoteAddress))
            {
                return false;
            }
            const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
            if (!secretMatches(token, query.get('token')))
            {
                return false;
            }
            return verifyOrigin(origin, request);
        },
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
