/**
 * MODULE: ws/attach - mounting WebSockets on a Node HTTP server
 *
 * WebSocket upgrades arrive on the HTTP server's 'upgrade' event, BEFORE any request
 * listener - so this attaches beside @azerothjs/http's serve() rather than through it:
 *
 *     const served = await serve(app);
 *     attachWebSockets(served.server, { path: '/ws', onConnection: (socket, request) => {...} });
 *
 * Requests failing the RFC 6455 handshake (or aimed at another path) are answered with a
 * plain HTTP error over the raw socket and never half-upgrade. Bytes the client sent
 * after its handshake (the 'head' buffer) are replayed into the connection's parser, so
 * an eager client's first frames are never lost.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { upgradeResponse, validateHandshake } from './handshake.ts';
import { ServerSocket, type ServerSocketOptions } from './socket.ts';

export interface AttachOptions extends ServerSocketOptions
{
    /** Only upgrade this exact pathname (default: every upgrade request). */
    path?: string;

    /**
     * Gate the upgrade on the request's Origin BEFORE the socket exists. A browser cannot
     * forge Origin, so this is the defense against cross-site WebSocket hijacking - a page on
     * another site opening a socket to your server with the visitor's cookies, which the
     * same-origin policy does NOT prevent (WebSockets are exempt from CORS).
     *
     * The default requires an Origin that names the same host:port the request was aimed at,
     * and refuses anything else with 403. A request with NO Origin is allowed: that is a
     * non-browser client, which carries no ambient cookies to steal. Supply this callback to
     * widen the set (an allowlist of trusted sites) or to narrow it; the value is null when
     * the request sends no Origin. Return false to refuse with 403.
     */
    verifyOrigin?: (origin: string | null, request: IncomingMessage) => boolean;

    /**
     * Maximum simultaneous connections on this endpoint (default: unlimited); further upgrades
     * are refused with 503. Every live connection can retain a frame buffer up to `maxPayload`,
     * so an unbounded endpoint lets a slow attacker exhaust memory with idle sockets.
     */
    maxConnections?: number;

    /** The connection handler: wire onMessage/onClose and start talking. */
    onConnection: (socket: ServerSocket, request: IncomingMessage) => void;

    /**
     * Lifecycle visibility at debug level: upgrades, closes, heartbeat reclaims.
     * STRUCTURAL on purpose - `@azerothjs/logger` (or anything with a debug method)
     * plugs in without this package taking a dependency on it.
     */
    logger?: { debug(message: string, fields?: Record<string, unknown>): void };
}

/** @internal A plain HTTP refusal on the raw socket (no upgrade happened). */
function refuse(socket: Socket, status: number, reason: string): void
{
    socket.write(`HTTP/1.1 ${ status } ${ reason }\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

/**
 * @internal Does `origin` name the same host:port the request was addressed to? The Host
 * header is parsed through URL so an IPv6 literal and a port keep their meaning, and an
 * opaque origin (the literal `null` a sandboxed frame sends) is never same-origin.
 */
function isSameOrigin(origin: string, host: string | undefined): boolean
{
    if (host === undefined)
    {
        return false;
    }
    let source: URL;
    let target: URL;
    try
    {
        source = new URL(origin);
        target = new URL(`http://${ host }`);
    }
    catch
    {
        return false;
    }
    // The Host header carries no scheme, so the origin's scheme decides the implied port.
    const implied = source.protocol === 'https:' || source.protocol === 'wss:' ? '443' : '80';
    const sourcePort = source.port === '' ? implied : source.port;
    const targetPort = target.port === '' ? implied : target.port;
    return source.hostname === target.hostname && sourcePort === targetPort;
}

/**
 * @internal Brands a socket THIS package accepted. Every 'upgrade' listener on a Node
 * server fires for every upgrade request, so a path-mismatched endpoint must not touch
 * the socket while a sibling endpoint may still claim it - the brand (plus
 * bytesWritten, which covers foreign WebSocket libraries writing their handshake) is
 * how the deferred 404 below tells "claimed elsewhere" from "nobody wants it".
 */
const kClaimed = Symbol('azerothjs.ws.claimed');

interface ClaimableSocket extends Socket
{
    [kClaimed]?: boolean;
}

/**
 * Attaches a WebSocket endpoint to `server`. Returns a detach function that removes the
 * upgrade listener AND destroys every live connection - so a graceful server shutdown is
 * not held open by upgraded sockets (an upgraded socket is detached from the HTTP server's
 * connection tracking, so `server.close()` alone would never drain it).
 */
export function attachWebSockets(server: Server, options: AttachOptions): () => void
{
    const live = new Set<Socket>();

    const listener = (request: IncomingMessage, socket: Socket, head: Buffer): void =>
    {
        const pathname = (request.url ?? '/').split('?')[0];
        if (options.path !== undefined && pathname !== options.path)
        {
            // Another endpoint (a second attachWebSockets, or a foreign WebSocket
            // library) may claim this upgrade - refusing here would destroy ITS
            // handshake, since every 'upgrade' listener fires. Refuse immediately only
            // when this listener is alone; otherwise defer one tick and refuse only if
            // NOBODY claimed the socket (first refuser destroys it, so siblings' checks
            // see `destroyed` and stand down - exactly one 404 per orphan upgrade).
            if (server.listenerCount('upgrade') <= 1)
            {
                refuse(socket, 404, 'Not Found');
                return;
            }
            setImmediate(() =>
            {
                const claimable = socket as ClaimableSocket;
                if (!socket.destroyed && claimable[kClaimed] !== true && socket.bytesWritten === 0)
                {
                    refuse(socket, 404, 'Not Found');
                }
            });
            return;
        }

        if (options.maxConnections !== undefined && live.size >= options.maxConnections)
        {
            refuse(socket, 503, 'Service Unavailable');
            return;
        }

        const origin = request.headers.origin ?? null;
        let allowed: boolean;
        try
        {
            allowed = options.verifyOrigin !== undefined
                ? options.verifyOrigin(origin, request)
                : origin === null || isSameOrigin(origin, request.headers.host);
        }
        catch (error)
        {
            // This runs inside the server's 'upgrade' listener, where a throw is an
            // uncaughtException that takes the process down, not a failed handshake.
            options.logger?.debug('ws origin gate threw', { error });
            refuse(socket, 500, 'Internal Server Error');
            return;
        }
        if (!allowed)
        {
            refuse(socket, 403, 'Forbidden');
            return;
        }

        const outcome = validateHandshake(request);
        if (!('key' in outcome))
        {
            refuse(socket, outcome.status, outcome.reason);
            return;
        }

        (socket as ClaimableSocket)[kClaimed] = true;
        live.add(socket);
        options.logger?.debug('ws open', { path: request.url ?? '/', clients: live.size });
        socket.once('close', () =>
        {
            live.delete(socket);
            options.logger?.debug('ws close', { path: request.url ?? '/', clients: live.size });
        });

        socket.write(upgradeResponse(outcome.key));
        const connection = new ServerSocket(socket, options);
        try
        {
            options.onConnection(connection, request);
        }
        catch (error)
        {
            // The same uncaughtException hazard as the origin gate, but the 101 is already on
            // the wire: the only refusal a peer can still read is the closing handshake.
            options.logger?.debug('ws connection handler threw', { error });
            connection.close(1011, 'Connection handler failed');
            return;
        }
        if (head.byteLength > 0)
        {
            socket.emit('data', head); // frames that raced the handshake re-enter the parser
        }
    };

    server.on('upgrade', listener);
    return () =>
    {
        server.off('upgrade', listener);
        for (const socket of live)
        {
            socket.destroy();
        }
        live.clear();
    };
}
