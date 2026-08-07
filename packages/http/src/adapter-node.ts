/**
 * MODULE: http/adapter-node - the edge where web-standard meets node:http
 *
 * The kernel speaks WHATWG Request/Response only; this module is the ONLY place Node's
 * IncomingMessage/ServerResponse exist. Three jobs:
 *
 *   - `toWebRequest`: IncomingMessage -> Request (lazy; see adapter-request.ts), with the
 *     client-disconnect AbortSignal available as `request.signal` - a handler that awaits a
 *     resource sees it fire the moment the client goes away.
 *   - `writeResponse`: Response -> ServerResponse. A kernel-constructed body (json/text/html,
 *     the error path) is written in ONE end() via the known-payload channel; everything else
 *     streams with real backpressure (a slow client pauses the producer instead of buffering
 *     unbounded). Set-Cookie is written as the multiple headers it must be.
 *   - `serve`: listen + GRACEFUL SHUTDOWN. `shutdown()` stops accepting, lets in-flight
 *     responses drain up to a deadline, then destroys what remains - deploys stop dropping
 *     requests mid-body, the flaw the incumbents leave to process managers.
 *
 * The listener is written against the small structural surface http1 and the http2 compat
 * API share, so the same code serves HTTP/1.1 and h2c: `serve` speaks 1.1, `serveH2c` speaks
 * cleartext HTTP/2 (an ALPN/TLS front can sit ahead of either in production).
 */

import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { createServer as createH2cServer, type Http2Server, type Http2ServerResponse } from 'node:http2';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { printBanner } from '@azerothjs/logger';
import { createAdapterRequest, type AnyIncoming, type ForwardedTrust } from './adapter-request.ts';
import { PayloadResponse } from './payload.ts';
import type { WebHandler } from './edge.ts';

type AnyOutgoing = ServerResponse | Http2ServerResponse;

/**
 * Declares the proxy in front of this server, `true` meaning both headers. OFF by default:
 * `X-Forwarded-*` is client-controlled, and believing it without a proxy lets any direct
 * caller forge its scheme and host - the same explicit trust boundary `clientIp` draws.
 */
export type TrustProxyOptions = boolean | ForwardedTrust;

/** @internal Normalizes the trust shorthand: `true` believes both headers. */
function forwardedTrust(trust: TrustProxyOptions | undefined): ForwardedTrust
{
    if (trust === true)
    {
        return { proto: true, host: true };
    }
    return trust === undefined || trust === false ? {} : trust;
}

/**
 * Converts a Node request into a web-standard Request - a LAZY one (see adapter-request.ts):
 * headers, disconnect signal, and body each materialize on first access, so the hot path
 * pays for nothing a handler does not touch. The scheme is the caller's statement about
 * what this socket actually speaks - the adapter cannot guess a TLS terminator's presence.
 * Behind a DECLARED terminating proxy, `trustProxy` lets `X-Forwarded-Proto`/`-Host`
 * override scheme and authority, so `context.url` tells the client's truth.
 */
export function toWebRequest(req: AnyIncoming, options: { scheme?: 'http' | 'https'; trustProxy?: TrustProxyOptions } = {}): Request
{
    return createAdapterRequest(req, options.scheme ?? 'http', forwardedTrust(options.trustProxy));
}

/**
 * Streams a Response onto a Node response with backpressure: an unflushed write pauses the
 * producer until the socket drains, so a slow client throttles the stream instead of
 * ballooning memory. Set-Cookie is written via getSetCookie() - the one header that must
 * not be joined.
 */
export async function writeResponse(res: AnyOutgoing, response: Response): Promise<void>
{
    // The kernel's own constructors return a PayloadResponse: status, a plain header record,
    // and the encoded bytes - one writeHead, one end, no undici and no stream machinery.
    if (response instanceof PayloadResponse)
    {
        if (!res.destroyed)
        {
            const raw = response.raw();
            (res as ServerResponse).writeHead(raw.status, raw.headers);
            (res as ServerResponse).end(raw.payload);
        }
        return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of response.headers)
    {
        if (name !== 'set-cookie')
        {
            headers[name] = value;
        }
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0)
    {
        headers['set-cookie'] = cookies;
    }

    if (res.destroyed)
    {
        // The client vanished before the handler finished; there is nothing to write to. The
        // body is still cancelled: it is what settles the request root, so dropping it silently
        // would leave every onRequestCleanup (a pooled connection, an open transaction, an
        // advisory lock) unreleased for the process lifetime.
        if (response.body !== null)
        {
            await response.body.cancel().catch(() =>
            {});
        }
        return;
    }
    // The union's writeHead overloads are mutually incompatible to TypeScript, but both accept
    // (status, headers). A non-empty statusText takes the http1 three-argument form so a
    // handler's reason phrase reaches the wire instead of being replaced by Node's default;
    // h2 has no reason phrase at all, and passing one there is harmless.
    if (response.statusText !== '')
    {
        (res as ServerResponse).writeHead(response.status, response.statusText, headers);
    }
    else
    {
        (res as ServerResponse).writeHead(response.status, headers);
    }

    if (response.body === null)
    {
        res.end();
        return;
    }

    // A manual read/write loop instead of pipeTo(Writable.toWeb(res)): Node's webstream
    // wrapper hits an internal assertion (ERR_INTERNAL_ASSERTION in
    // writableStreamDefaultControllerGetChunkSize) when the socket is destroyed mid-pipe -
    // exactly the client-disconnect case a server sees daily. The loop keeps the same
    // backpressure (an unflushed write awaits 'drain') with full control over destruction.
    const reader = response.body.getReader();
    try
    {
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- @types/node types destroyed as always-false on this union; it flips true when the client disconnects mid-stream
            if (res.destroyed)
            {
                await reader.cancel();
                return;
            }
            const flushed = (res as ServerResponse).write(value);
            if (!flushed)
            {
                // Backpressure: pause the producer until the socket drains. 'close' also
                // releases the wait so a client that dies while we are paused cannot hang
                // the response forever - the next loop iteration sees destroyed and stops.
                await new Promise<void>((resolve) =>
                {
                    const onDrain = (): void =>
                    {
                        res.off('close', onDrain);
                        resolve();
                    };
                    res.once('drain', onDrain);
                    res.once('close', onDrain);
                });
            }
        }
        res.end();
    }
    catch
    {
        // The producer stream failed mid-body; the response cannot be salvaged.
        await reader.cancel().catch(() => undefined);
        res.destroy();
    }
}

/**
 * The served-socket handle that `serve`/`serveH2c` return. Generic over the concrete server
 * class so a caller that needs the real HTTP/1 `Server` (for ws attachment or socket tuning)
 * keeps its exact type: `serve` yields `Served<Server>`, `serveH2c` yields `Served<Http2Server>`,
 * and the default union keeps bare annotations working.
 */
export interface Served<S extends Server | Http2Server = Server | Http2Server>
{
    /** The listening Node server (for address(), unref(), test hooks). */
    server: S;

    /** The bound port (resolved even when 0 was requested). */
    port: number;

    /**
     * Graceful shutdown: stop accepting, wait for in-flight responses up to `gracePeriodMs`
     * (default 10s), then destroy whatever remains. Resolves when the server is fully closed.
     */
    shutdown(options?: { gracePeriodMs?: number | undefined }): Promise<void>;
}

/**
 * A connect-style middleware: handles the raw Node request itself or calls `next()` to pass
 * it on. This is the ONE non-web-standard extension point, and it exists for exactly one
 * ecosystem: dev tooling (Vite's middleware mode, and anything else connect-shaped) runs
 * AHEAD of the app - it owns module/HMR/asset requests and falls through to the app's
 * routes for everything real. Production servers simply do not pass one.
 */
export type ConnectMiddleware = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: (error?: unknown) => void
) => void;

/** @internal Shared listen + drain machinery for both protocol servers - ONE request listener. */
function manage<S extends Server | Http2Server>(
    server: S,
    app: WebHandler,
    port: number,
    hostname: string | undefined,
    before?: ConnectMiddleware,
    trust: ForwardedTrust = {}
): Promise<Served<S>>
{
    const inFlight = new Set<AnyOutgoing>();
    server.on('request', (req: AnyIncoming, res: AnyOutgoing) =>
    {
        inFlight.add(res);
        res.once('close', () => inFlight.delete(res));
        const dispatch = (): void =>
        {
            // The LAST line of defence for the process. `App.handle` cannot reject, but a
            // `WebHandler` composed by `pipeline()` can (a throwing middleware), and
            // `writeResponse` runs after handle() resolved, outside the kernel's error path -
            // an invalid status or a header value Node refuses throws from writeHead. Without
            // this catch either becomes an unhandled rejection, and Node's default policy for
            // one is to terminate: a single request would take down every live connection.
            app.handle(createAdapterRequest(req, 'http', trust))
                .then((response) => writeResponse(res, response))
                .catch(() =>
                {
                    if (!res.destroyed && !res.headersSent)
                    {
                        (res as ServerResponse).writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                        res.end('Internal Server Error');
                        return;
                    }
                    // Headers are already on the wire, so the framing cannot be corrected;
                    // dropping the connection is the only honest end to the message.
                    res.destroy();
                });
        };
        if (before !== undefined)
        {
            // The middleware either answers (dev-server asset/HMR traffic) or nexts into the
            // app. An error passed to next() flows through the app's error path via a throw
            // inside handle()'s reach - here the pragmatic mapping is a plain 500, because a
            // connect middleware failing is a dev-tooling crash, not an application error.
            before(req as import('node:http').IncomingMessage, res as ServerResponse, (error) =>
            {
                if (error !== undefined && error !== null)
                {
                    if (!res.destroyed && !res.headersSent)
                    {
                        (res as ServerResponse).writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                        res.end('Dev middleware error');
                    }
                    return;
                }
                dispatch();
            });
            return;
        }
        dispatch();
    });

    return new Promise((resolve, reject) =>
    {
        server.once('error', reject);
        server.listen(port, hostname, () =>
        {
            // Under load, address() can momentarily be null even inside the listening
            // callback (seen on Windows). Falling back to the REQUESTED port would hand an
            // ephemeral-port caller port 0 - an unusable address - so retry a few ticks and
            // fail loudly rather than resolve with a lie.
            let attempts = 0;
            const settle = (): void =>
            {
                const address = server.address();
                if (typeof address !== 'object' || address === null)
                {
                    if (++attempts > 50)
                    {
                        reject(new Error('serve(): the socket never reported its bound address.'));
                        return;
                    }
                    setImmediate(settle);
                    return;
                }
                finish(address.port);
            };
            settle();
        });

        function finish(boundPort: number): void
        {
            resolve({
                server,
                port: boundPort,
                shutdown: async ({ gracePeriodMs = 10_000 } = {}) =>
                {
                    const closed = new Promise<void>((done) => server.close(() => done()));
                    // http1 keep-alive sockets with no active request would stall close();
                    // drop them immediately - only genuinely in-flight work gets the grace.
                    (server as Partial<Server>).closeIdleConnections?.();

                    if (inFlight.size > 0)
                    {
                        // Both timers are cleared on EITHER outcome. `Promise.race` settles on
                        // the winner and abandons the loser, so a lone `clearInterval` inside
                        // the drain branch left the poll running forever when the grace period
                        // won (nothing could then end the process on its own), and the grace
                        // timer held the loop open for its full duration when the drain won.
                        let check: ReturnType<typeof setInterval> | undefined;
                        let expiry: ReturnType<typeof setTimeout> | undefined;
                        try
                        {
                            await Promise.race([
                                new Promise<void>((done) =>
                                {
                                    check = setInterval(() =>
                                    {
                                        if (inFlight.size === 0)
                                        {
                                            done();
                                        }
                                    }, 10);
                                }),
                                new Promise<void>((done) =>
                                {
                                    expiry = setTimeout(done, gracePeriodMs);
                                })
                            ]);
                        }
                        finally
                        {
                            clearInterval(check);
                            clearTimeout(expiry);
                        }
                    }
                    (server as Partial<Server>).closeAllConnections?.();
                    await closed;
                }
            });
        }
    });
}

/**
 * Socket-level timeouts. Node ships these OFF or generous, so a slow or idle peer can pin a
 * connection indefinitely; production servers want them bounded and aligned with the load
 * balancer in front. Each is surfaced here, defaulted to a safe value, and overridable.
 */
export interface SocketTimeouts
{
    /** Time to receive the COMPLETE request headers before the socket is closed (default 60s). Slowloris defense. */
    headersMs?: number;

    /** Time to receive the complete request (headers + body) before closing (default 5min). */
    requestMs?: number;

    /** How long an idle keep-alive socket is held open awaiting the next request (default 5s). */
    keepAliveMs?: number;

    /** Max requests one keep-alive socket may serve before it must reconnect (default 0 = unlimited). */
    maxRequestsPerSocket?: number;

    /**
     * How often the server sweeps for connections that blew past headersTimeout/requestTimeout
     * (default 30000 ms - Node's default). The timeouts above are enforced ON this sweep, so a
     * slowloris is reclaimed within headersTimeout + this interval; lower it to reclaim sooner.
     */
    checkIntervalMs?: number;
}

const DEFAULT_TIMEOUTS: Required<Omit<SocketTimeouts, 'checkIntervalMs'>> = {
    headersMs: 60_000,
    requestMs: 300_000,
    keepAliveMs: 5_000,
    maxRequestsPerSocket: 0
};

/** @internal Applies the four http1 socket timeouts to a server, defaulting each. */
function applyTimeouts(server: Server, timeouts: SocketTimeouts = {}): void
{
    server.headersTimeout = timeouts.headersMs ?? DEFAULT_TIMEOUTS.headersMs;
    server.requestTimeout = timeouts.requestMs ?? DEFAULT_TIMEOUTS.requestMs;
    server.keepAliveTimeout = timeouts.keepAliveMs ?? DEFAULT_TIMEOUTS.keepAliveMs;
    server.maxRequestsPerSocket = timeouts.maxRequestsPerSocket ?? DEFAULT_TIMEOUTS.maxRequestsPerSocket;
}

/** @internal This package's version, read lazily from its own manifest; undefined if unreadable. */
let cachedVersion: string | undefined | null = null;
function packageVersion(): string | undefined
{
    if (cachedVersion === null)
    {
        try
        {
            cachedVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version;
        }
        catch
        {
            cachedVersion = undefined;
        }
    }
    return cachedVersion;
}

/**
 * @internal The startup banner - the framework's face. printBanner self-gates (TTY only,
 * never in production), so a piped or collected stream stays byte-clean. The addresses
 * shown are the addresses actually BOUND, not the ones requested.
 */
function announce(served: Served, subtitle: string, readyMs: number): void
{
    const address = served.server.address();
    const bound = typeof address === 'object' && address !== null ? address.address : undefined;
    const unspecified = bound === undefined || bound === '0.0.0.0' || bound === '::';
    const entries: Array<readonly [string, string]> = [];
    if (unspecified)
    {
        entries.push(['Local', `http://localhost:${ served.port }`]);
        for (const nets of Object.values(networkInterfaces()))
        {
            for (const net of nets ?? [])
            {
                if (net.family === 'IPv4' && !net.internal)
                {
                    entries.push(['Network', `http://${ net.address }:${ served.port }`]);
                }
            }
        }
    }
    else
    {
        const host = bound === '::1' ? 'localhost' : bound;
        entries.push(['Local', `http://${ host }:${ served.port }`]);
    }
    printBanner({ version: packageVersion(), subtitle, entries, readyMs });
}

/**
 * Serves an app over HTTP/1.1. `port: 0` binds an ephemeral port (the testing default).
 * `before` mounts a connect-style middleware ahead of the app - the dev-server seam
 * (`serve(app, { before: vite.middlewares })`); see {@link ConnectMiddleware}. `timeouts`
 * tunes the socket-level limits (all bounded by default; see {@link SocketTimeouts}).
 * On an interactive dev terminal the AzerothJS banner announces the bound addresses and
 * the measured ready time; `banner: false` silences it (it is always silent when piped
 * or in production).
 */
export async function serve(
    app: WebHandler,
    options: { port?: number; hostname?: string; before?: ConnectMiddleware; timeouts?: SocketTimeouts; banner?: boolean; trustProxy?: TrustProxyOptions } = {}
): Promise<Served<Server>>
{
    const startedAt = performance.now();
    const timeouts = options.timeouts ?? {};
    const server = timeouts.checkIntervalMs !== undefined
        ? createServer({ connectionsCheckingInterval: timeouts.checkIntervalMs })
        : createServer();
    applyTimeouts(server, timeouts);
    const served = await manage(server, app, options.port ?? 0, options.hostname, options.before, forwardedTrust(options.trustProxy));
    if (options.banner !== false)
    {
        announce(served, 'http', performance.now() - startedAt);
    }
    return served;
}

/**
 * Serves an app over cleartext HTTP/2 (h2c) - the same listener, the http2 compat surface.
 * Browsers only speak h2 over TLS; h2c is for internal hops, proxies, and gRPC-style peers.
 */
export function serveH2c(app: WebHandler, options: { port?: number; hostname?: string; trustProxy?: TrustProxyOptions } = {}): Promise<Served<Http2Server>>
{
    return manage(createH2cServer(), app, options.port ?? 0, options.hostname, undefined, forwardedTrust(options.trustProxy));
}

/** Options for {@link handleShutdownSignals}. */
export interface ShutdownSignalOptions
{
    /** Which signals trigger the drain (default SIGTERM + SIGINT - the orchestrator and Ctrl-C signals). */
    signals?: NodeJS.Signals[];

    /** Forwarded to `shutdown()`: how long in-flight requests get to finish (default 10s). */
    gracePeriodMs?: number;

    /** Called if the drain itself throws; the process still exits. */
    onError?: (error: unknown) => void;

    /**
     * Runs AFTER the server has drained, BEFORE the process exits - the seam for
     * everything else that needs a graceful stop beside the HTTP server: a cron
     * scheduler's `stop({ drain: true })`, a log sink's `close()`, a DB pool's end.
     * Its throw goes to `onError`; the process still exits.
     */
    beforeExit?: () => void | Promise<void>;

    /** Process-exit hook, injectable for tests (default `process.exit`). */
    exit?: (code: number) => void;
}

/**
 * Wires a graceful drain to process signals: on SIGTERM/SIGINT the server stops accepting,
 * lets in-flight requests finish (up to the grace period), then exits 0. This is the piece
 * that makes rolling deploys and orchestrator restarts stop dropping requests mid-flight -
 * the incumbents leave it to a process manager and hope. Returns a disposer that removes the
 * listeners (so tests and re-wiring do not leak process handlers).
 */
export function handleShutdownSignals(served: Served, options: ShutdownSignalOptions = {}): () => void
{
    const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
    const exit = options.exit ?? ((code: number): void =>
    {
        process.exit(code);
    });
    let draining = false;

    const handler = (): void =>
    {
        if (draining)
        {
            return; // a second signal during the drain must not start a second drain
        }
        draining = true;
        void served.shutdown({ gracePeriodMs: options.gracePeriodMs })
            .then(async () => options.beforeExit?.())
            .catch((error: unknown) => options.onError?.(error))
            .finally(() => exit(0));
    };

    for (const signal of signals)
    {
        process.on(signal, handler);
    }
    return (): void =>
    {
        for (const signal of signals)
        {
            process.removeListener(signal, handler);
        }
    };
}
