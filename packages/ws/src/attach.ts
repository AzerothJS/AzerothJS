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
     * Gate the upgrade on the request's Origin BEFORE the socket exists (default: allow any).
     * A browser cannot forge Origin, so an allowlist here is the defense against cross-site
     * WebSocket hijacking - a page on another site opening a socket to your server with the
     * visitor's cookies. Return false to refuse with 403; the value is null for non-browser
     * clients that send no Origin.
     */
    verifyOrigin?: (origin: string | null, request: IncomingMessage) => boolean;

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

        if (options.verifyOrigin !== undefined)
        {
            const origin = request.headers.origin ?? null;
            if (!options.verifyOrigin(origin, request))
            {
                refuse(socket, 403, 'Forbidden');
                return;
            }
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
        options.onConnection(connection, request);
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
