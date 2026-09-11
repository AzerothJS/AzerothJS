/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The dev session: the production page mount, fed by vite instead of by a build.
 *
 * `devPages(options)` creates the vite server, loads the application's SSR entry from SOURCE
 * and mounts the SAME `mountPages` over the SAME route table and renderer production uses,
 * with vite's transformed `index.html` as the shell. One process, one origin: the pages, the
 * api and the HMR socket all answer on the server the application already runs, so dev serves
 * the page contract production serves - guards as status, page actions, locale negotiation,
 * ISR, streaming, the CSP nonce and the manifest splice included.
 *
 * The swap lives inside one stable App: the outer App carries the application's api routes and
 * a GET/POST catch-all delegating to the CURRENT inner App, which is rebuilt on the first
 * request after a change. A build that fails is a readable answer, never a dead session.
 *
 * `vite` itself is imported dynamically and declared nowhere in this package's manifest: the
 * application half owns that dependency, so a production image that never installs it still
 * imports `@azerothjs/kit`.
 */

import { statSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createRelay } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { resolve as resolvePath } from 'node:path';

import { App, HttpError, html as htmlResponse } from '@azerothjs/http';
import type { AppOptions, RequestContext } from '@azerothjs/http';
import type { ConnectMiddleware } from '@azerothjs/http/node';

import { mountPages } from '../index.ts';
import type { KitOptions, PageRoute } from '../index.ts';
import type { PageRenderer } from '../ssr.ts';
import { SSR_SOURCE_ENTRY } from './entry.ts';

/** The vite range this session is written and measured against. */
const VITE_RANGE = '^8.0.0';

/** The url prefixes vite owns outright; everything else is the application's. */
const VITE_PREFIXES = ['/@vite/', '/@id/', '/@fs/', '/node_modules/'];

/** Every CSI escape vite's own formatters leave in a message or a frame. */
// eslint-disable-next-line no-control-regex -- the escape character IS what this strips
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** What {@link devPages} needs: the application root, its entry, and the app around the pages. */
export interface DevPagesOptions
{
    /** The application root - vite's `root`, and where vite finds its own config file. */
    root: string;

    /** The SSR entry relative to {@link root} (default: `SSR_SOURCE_ENTRY`). */
    entry?: string;

    /**
     * Everything `mountPages` takes except the four this session owns: the route table and the
     * renderer come from the entry module, and the shell is vite's transformed `index.html`
     * rather than a built client directory.
     */
    pages: Omit<KitOptions, 'routes' | 'renderer' | 'shell' | 'clientDir'>;

    /** The application's own api routes, registered once on the session's App. */
    routes: (app: App) => void;

    /** Error, observability and timeout policy for the session's App. */
    app?: Pick<AppOptions, 'dev' | 'onError' | 'serializeError' | 'observe' | 'responseTimeoutMs'>;

    /**
     * The module the single-instance check resolves `azerothjs` from - the server half's own
     * entry, when that is not this package (default: this module).
     */
    serverAnchor?: string;
}

/** One dev session: the App to serve, vite's seam ahead of it, and its lifetime. */
export interface DevSession
{
    /** The App to serve: the application's api routes plus the pages, rebuilt in place. */
    app: App;

    /** The connect middleware `serve`'s `before` takes - vite sees only its own requests. */
    before: ConnectMiddleware;

    /**
     * Rides the HMR socket on the app's own listening server. Vite was given no socket of its
     * own, so the page dials its own origin. At most one subscription per session: a second
     * call is a no-op, as is a call after {@link DevSession.close}.
     */
    attach(server: Server): void;

    /** Closes vite, then unsubscribes from the app server. */
    close(): Promise<void>;
}

/**
 * Whether this vite is the one the session is written against. Major 8 only: the seam reads the
 * resolved config, the ws relay and the ssr module graph, none of which is stable across majors.
 */
export function supportsVite(version: string): boolean
{
    return /^\s*v?(\d+)\./.exec(version)?.[1] === '8';
}

/**
 * Whether a socket peer is on this machine, in every spelling a dual-stack bind reports:
 * `127.0.0.0/8`, `::1`, and an IPv4-mapped `::ffff:127.x`. `/__open-in-editor` opens files in
 * the developer's editor, so a LAN peer must never reach it.
 */
export function isLoopbackAddress(address: string | undefined): boolean
{
    if (address === undefined)
    {
        return false;
    }
    const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
    return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

/** @internal One spelling for every path comparison: vite's ids and config are POSIX already. */
function toPosix(value: string): string
{
    return value.replace(/\\/g, '/');
}

/** @internal Whether a POSIX path lies inside a POSIX directory (the directory itself counts). */
function isInside(directory: string, target: string): boolean
{
    return target === directory || target.startsWith(directory.endsWith('/') ? directory : `${ directory }/`);
}

/**
 * @internal Whether the decoded pathname names a real file inside this directory. Containment is
 * decided BEFORE the isFile test, on POSIX-normalized paths on both sides - `path.resolve`
 * answers backslashes on win32 while vite's config is POSIX, and a mixed comparison forwards
 * nothing.
 */
function fileUnder(directory: string, pathname: string): boolean
{
    const base = toPosix(resolvePath(directory));
    const target = toPosix(resolvePath(directory, `.${ pathname }`));
    if (!isInside(base, target))
    {
        return false;
    }
    return statSync(target, { throwIfNoEntry: false })?.isFile() === true;
}

/** @internal Whether the client asked for a document rather than an asset or a JSON api. */
function acceptsHtml(request: Request): boolean
{
    return (request.headers.get('accept') ?? '')
        .split(',')
        .some((entry) => entry.trim().toLowerCase().startsWith('text/html'));
}

/** @internal Where Node resolves `azerothjs` from one anchor, through the symlink to its real file. */
function copyFrom(anchor: string, what: string): string
{
    try
    {
        return realpathSync.native(createRequire(anchor).resolve('azerothjs/package.json'));
    }
    catch (cause)
    {
        throw new Error(`@azerothjs/kit/dev: cannot resolve "azerothjs" from ${ what } (${ anchor }) - the `
            + 'application and the server half must both see the runtime this session renders with.', { cause });
    }
}

/**
 * @internal One process holds ONE `azerothjs`: the request scope, the per-request data cache and
 * the store registry all live on the copy each half resolved, and a second copy splits them
 * silently. Blind to a bundler alias and to vite inlining - which is why the application's vite
 * config keeps `azerothjs` external.
 */
function assertOneCopy(root: string, anchor: string): void
{
    const fromRoot = copyFrom(resolvePath(root, 'package.json'), 'the application root');
    const fromServer = copyFrom(anchor, 'the server half');
    if (fromRoot !== fromServer)
    {
        throw new Error('@azerothjs/kit/dev: two copies of "azerothjs" are installed - the application root '
            + `resolves ${ fromRoot } and the server half resolves ${ fromServer }. One process holds one `
            + 'instance of the runtime; dedupe the dependency so both halves resolve the same package.');
    }
}

/** @internal Where the vite this module imports lives - its own resolution first, then the root's. */
function viteLocation(root: string): string
{
    for (const anchor of [import.meta.url, resolvePath(root, 'package.json')])
    {
        try
        {
            return createRequire(anchor).resolve('vite/package.json');
        }
        catch
        {
            // The next anchor may name it.
        }
    }
    return 'the copy @azerothjs/kit resolves';
}

/**
 * @internal Loads vite with the kit's own failure message, and refuses a version this session was
 * never measured against - before anything is created.
 */
async function loadVite(root: string): Promise<typeof import('vite')>
{
    let vite: typeof import('vite');
    try
    {
        vite = await import('vite');
    }
    catch (cause)
    {
        throw new Error(`@azerothjs/kit/dev needs vite ${ VITE_RANGE }, and none could be imported. Declare it in `
            + `the devDependencies of the application half (${ root }) at the range the application builds with; `
            + 'the kit declares nothing about vite, so a production image never installs it.', { cause });
    }
    if (!supportsVite(vite.version))
    {
        throw new Error(`@azerothjs/kit/dev needs vite ${ VITE_RANGE }, but loaded ${ viteLocation(root) } at `
            + `version ${ vite.version }. The session reads the resolved config, the ws relay and the ssr module `
            + 'graph, none of which is stable across majors.');
    }
    return vite;
}

/** @internal A build failure, reduced to what both answers render. */
interface BuildFailure
{
    id?: string;
    message: string;
    loc?: { file?: string; line?: number; column?: number };
    frame?: string;
}

/**
 * @internal Reads a build failure once, at the boundary: the ANSI escapes are stripped here so
 * neither answer renders them, and `loc`/`frame` are carried only when the failure has them (a
 * `.ts` transform failure has neither, and its position lives inside the message).
 */
function describeFailure(error: unknown): BuildFailure
{
    const source = error as { id?: unknown; loc?: unknown; frame?: unknown };
    const failure: BuildFailure = {
        message: (error instanceof Error ? error.message : String(error)).replace(ANSI, '')
    };
    if (typeof source.id === 'string')
    {
        failure.id = source.id;
    }
    if (typeof source.frame === 'string')
    {
        failure.frame = source.frame.replace(ANSI, '');
    }
    if (typeof source.loc === 'object' && source.loc !== null)
    {
        const loc = source.loc as { file?: unknown; line?: unknown; column?: unknown };
        failure.loc = {
            ...(typeof loc.file === 'string' ? { file: loc.file } : {}),
            ...(typeof loc.line === 'number' ? { line: loc.line } : {}),
            ...(typeof loc.column === 'number' ? { column: loc.column } : {})
        };
    }
    return failure;
}

/** @internal Text into html. */
function escapeHtml(value: string): string
{
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @internal The page an html navigation gets while the build is broken. */
function devErrorPage(failure: BuildFailure): string
{
    const line = failure.loc?.line;
    const column = failure.loc?.column;
    const position = line === undefined
        ? ''
        : `<p class="at">vite reported line ${ line }${ column === undefined ? '' : `, column ${ column }` }</p>\n`;
    const frame = failure.frame === undefined ? '' : `<pre class="frame">${ escapeHtml(failure.frame) }</pre>\n`;
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"/>\n<title>Build failed</title>\n'
        + '<style>'
        + 'body{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b1118;color:#e6edf3;margin:0;padding:32px}'
        + 'h1{font-size:16px;color:#ff7b72;margin:0 0 8px}'
        + '.file{color:#79c0ff;margin:0 0 16px;word-break:break-all}'
        + 'pre{background:#111820;border:1px solid #21262d;border-radius:6px;padding:12px;overflow:auto;white-space:pre-wrap}'
        + '.at{color:#8b949e}'
        + '</style>\n</head>\n<body>\n<h1>The dev build failed</h1>\n'
        + `<p class="file">${ escapeHtml(failure.id ?? 'no file reported') }</p>\n`
        + `<pre class="message">${ escapeHtml(failure.message) }</pre>\n${ position }${ frame }`
        + '<p class="at">Fix it and reload - the session rebuilds on the first request after a change.</p>\n'
        + '</body>\n</html>\n';
}

/**
 * Creates the dev session: one vite server, one App, and the page mount production runs.
 *
 * Refused at startup rather than failing silently later: a second copy of `azerothjs`, a vite
 * outside {@link supportsVite}, a `server.proxy` (this session IS that seam), a `base` other
 * than `/`, `server.watch: null` (no watcher exists, so nothing would ever rebuild), and any
 * `port`, `clientPort` or `host` under `server.ws` or its deprecated `server.hmr` spelling -
 * each pins a socket target into the page that nothing listens on, and vite reports none of
 * them. A `server.ws.path` is honoured.
 */
export async function devPages(options: DevPagesOptions): Promise<DevSession>
{
    // The real path, in one spelling: vite compares what it serves against real paths, so a
    // junction or an 8.3 short name as the root would 403 every source file.
    const root = realpathSync.native(resolvePath(options.root));
    assertOneCopy(root, options.serverAnchor ?? import.meta.url);
    const loaded = await loadVite(root);

    // Never listens: vite attaches its own upgrade listener here, and `attach` re-emits the app
    // server's upgrades onto it, so the compiled client dials the page's own origin.
    const relay = createRelay();
    const changed = new Set<string>();
    let dirty = true;
    // The root is the one setting a self-restart cannot change: the inline value wins over the
    // config file, so the containment test reads it here rather than through the server.
    const rootPath = toPosix(root);

    // The hook fires BEFORE vite's own invalidation, and is re-created with the server when a
    // config change restarts it - which is why the subscription lives here, not on a watcher.
    const recorder = {
        name: 'azeroth:dev-session',
        watchChange(id: string): void
        {
            const path = toPosix(id);
            if (!isInside(rootPath, path))
            {
                return;
            }
            changed.add(path);
            dirty = true;
        }
    };

    // `configLoader: 'runner'` loads the config through vite's module runner. The default
    // bundles it into a temp file, imports that through node and deletes it, which `node --watch`
    // counts as a change: the process restarts, loads the config again, and never settles.
    const server = await loaded.createServer({
        root,
        appType: 'custom',
        configLoader: 'runner',
        server: { middlewareMode: true, ws: { server: relay }, hmr: { overlay: true } },
        plugins: [recorder]
    });

    const refuse = async (message: string): Promise<never> =>
    {
        await server.close();
        throw new Error(message);
    };
    const configFile = server.config.configFile ?? `${ options.root } (no vite config file)`;
    if (server.config.server.proxy !== undefined)
    {
        await refuse(`@azerothjs/kit/dev: remove server.proxy from ${ configFile } - the dev session IS that `
            + 'seam. The api and the pages answer on one origin, so there is nothing left to proxy to.');
    }
    if (server.config.base !== '/')
    {
        await refuse(`@azerothjs/kit/dev: base must be "/" in dev, and ${ configFile } sets `
            + `"${ server.config.base }" - every vite url the page asks for would carry it, the seam forwards `
            + 'only unprefixed vite urls, and the page would 404 silently.');
    }
    if (server.config.server.watch === null)
    {
        await refuse(`@azerothjs/kit/dev: remove server.watch: null from ${ configFile } - it creates no watcher `
            + 'at all, so nothing would ever rebuild and the first build would serve forever. `false` is a real '
            + 'watcher and is fine.');
    }
    for (const socket of [
        { spelling: 'server.ws', value: server.config.server.ws as unknown },
        { spelling: 'server.hmr', value: server.config.server.hmr as unknown }
    ])
    {
        if (typeof socket.value !== 'object' || socket.value === null)
        {
            continue;
        }
        const pinned = socket.value as { port?: unknown; clientPort?: unknown; host?: unknown };
        for (const setting of ['port', 'clientPort', 'host'] as const)
        {
            if (pinned[setting] !== undefined)
            {
                await refuse(`@azerothjs/kit/dev: remove ${ socket.spelling }.${ setting } from ${ configFile } - `
                    + 'the HMR socket rides the app\'s own server, so the page dials its own origin. A pinned '
                    + `${ setting } compiles a socket target into the page that nothing listens on, and vite `
                    + 'reports nothing when it does. `server.ws.path` is honoured.');
            }
        }
    }

    // The inner App carries the error policy but NOT `observe`: `inner.handle` never throws, so
    // the inner policy answers every page error, and observing in both roots logs every page
    // request twice.
    const innerOptions: AppOptions = {
        ...(options.app?.dev !== undefined ? { dev: options.app.dev } : {}),
        ...(options.app?.onError !== undefined ? { onError: options.app.onError } : {}),
        ...(options.app?.serializeError !== undefined ? { serializeError: options.app.serializeError } : {})
    };
    const entryPath = (): string => resolvePath(server.config.root, options.entry ?? SSR_SOURCE_ENTRY);

    /** Vite's own invalidation runs after the hook, so the session owns the window in between. */
    const drain = (): void =>
    {
        if (changed.size === 0)
        {
            return;
        }
        const graph = server.environments.ssr.moduleGraph;
        for (const id of changed)
        {
            graph.onFileChange(id);
        }
        changed.clear();
    };

    /** A render error unwinds through vite's own source maps before anything reports it. */
    const readable = (render: PageRenderer): PageRenderer => async (url, shell, renderOptions) =>
    {
        try
        {
            return await render(url, shell, renderOptions);
        }
        catch (error)
        {
            if (error instanceof Error)
            {
                server.ssrFixStacktrace(error);
            }
            throw error;
        }
    };

    let current: App | undefined;
    let building: Promise<App> | undefined;

    const build = async (): Promise<App> =>
    {
        dirty = false;
        try
        {
            drain();
            // Re-read and re-transformed per rebuild: an index.html edit is a source edit, and a
            // shell held across one serves the text the session started with.
            const shell = await server.transformIndexHtml(
                '/',
                await readFile(resolvePath(server.config.root, 'index.html'), 'utf8'));
            const entry = await server.ssrLoadModule(entryPath()) as Partial<{ routes: PageRoute[]; renderPage: PageRenderer }>;
            if (!Array.isArray(entry.routes) || typeof entry.renderPage !== 'function')
            {
                throw new Error(`@azerothjs/kit/dev: "${ entryPath() }" must export "routes" (the page table) and `
                    + '"renderPage" (createPageRenderer(App, routes)) - the two names a production mount and the '
                    + 'prerender bin read. One of them is missing.');
            }
            const inner = new App(innerOptions);
            mountPages(inner, { ...options.pages, routes: entry.routes, renderer: readable(entry.renderPage), shell });
            current = inner;
            return inner;
        }
        catch (error)
        {
            // A module that throws while it EVALUATES has a stack pointing into the transformed
            // text; vite maps it back to the source before either answer reads it.
            if (error instanceof Error)
            {
                server.ssrFixStacktrace(error);
            }
            if (current === undefined)
            {
                throw error;
            }
            // The frame is vite's own log, printed once as it failed; this says what is being
            // served in the meantime.
            const failed = describeFailure(error);
            server.config.logger.warn(`[azeroth] kept serving the previous build - ${ failed.id ?? entryPath() } failed to build`);
            return current;
        }
        finally
        {
            building = undefined;
        }
    };

    const currentApp = async (): Promise<App> =>
    {
        // A request that lands while a rebuild is in flight joins it: `build` clears `dirty` as
        // it starts, so the flag alone would hand out the previous App until the swap.
        if (building !== undefined)
        {
            return building;
        }
        if (!dirty && current !== undefined)
        {
            return current;
        }
        building = build();
        return building;
    };

    const app = new App(options.app ?? {});
    options.routes(app);

    const delegate = async (context: RequestContext): Promise<Response> =>
    {
        let inner: App;
        try
        {
            inner = await currentApp();
        }
        catch (error)
        {
            const failure = describeFailure(error);
            if (acceptsHtml(context.request))
            {
                return htmlResponse(devErrorPage(failure), { status: 500, headers: { 'cache-control': 'no-store' } });
            }
            throw new HttpError(500, failure.message, {
                code: 'dev-build-failed',
                details: { id: failure.id ?? entryPath() },
                cause: error
            });
        }
        // The inner App never throws, so it is the inner policy that answers every page error.
        return inner.handle(context.request);
    };

    // GET (and therefore HEAD) and POST only: an outer wildcard holding a verb rewrites the
    // 405/Allow the application's OWN api routes answer with. `/*path` does not match the root
    // url, so both patterns are registered.
    app.get('/', delegate);
    app.get('/*path', delegate);
    app.post('/', delegate);
    app.post('/*path', delegate);

    /** Whether this request belongs to vite: its own urls, or a real file under root/publicDir. */
    const viteOwns = (pathname: string, peer: string | undefined): boolean =>
    {
        if (VITE_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
        {
            return true;
        }
        if (pathname.startsWith('/__open-in-editor'))
        {
            return isLoopbackAddress(peer);
        }
        // Public assets live under publicDir, not under root, and `publicDir: false` resolves
        // to the empty string.
        const publicDir = server.config.publicDir;
        return fileUnder(server.config.root, pathname) || (publicDir !== '' && fileUnder(publicDir, pathname));
    };

    const before: ConnectMiddleware = (request, response, next): void =>
    {
        const target = request.url ?? '/';
        const query = target.indexOf('?');
        // The pathname decides; the URL is forwarded UNCHANGED, because the query selects the
        // transform. A malformed escape throws here and the adapter answers its own 500.
        const pathname = decodeURIComponent(query < 0 ? target : target.slice(0, query));
        // A NUL byte names no file; the kernel answers it rather than a stat that throws.
        if (!pathname.includes('\0') && viteOwns(pathname, request.socket.remoteAddress))
        {
            // The adapter's own `next`, so a request vite declines or fails to transform still
            // reaches the kernel.
            server.middlewares(request, response, next);
            return;
        }
        next();
    };

    let subscription: { target: Server; forward: (request: IncomingMessage, socket: Socket, head: Buffer) => void } | undefined;
    let closed = false;

    const attach = (target: Server): void =>
    {
        // A second forwarder re-emits one upgrade twice, and vite's handleUpgrade then throws out
        // of the server's own listener as an uncaughtException that exits the process.
        if (closed || subscription !== undefined)
        {
            return;
        }
        const forward = (request: IncomingMessage, socket: Socket, head: Buffer): void =>
        {
            try
            {
                relay.emit('upgrade', request, socket, head);
            }
            catch
            {
                // Vite is mid self-restart: for a few milliseconds two of its listeners sit on
                // the relay and ws refuses the second handshake. The client's poll retries.
                socket.destroy();
                return;
            }
            // The claim rule attachWebSockets and the devtools bridge apply: an upgrade nobody
            // wrote to one tick later is nobody's, so a stray Upgrade still gets an answer.
            setImmediate(() =>
            {
                if (!socket.destroyed && socket.bytesWritten === 0)
                {
                    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                    socket.destroy();
                }
            });
        };
        target.on('upgrade', forward);
        subscription = { target, forward };
    };

    const close = async (): Promise<void> =>
    {
        closed = true;
        // Vite first: closing it detaches its own listener from the relay and terminates every
        // live client, so an open tab starts polling for the next boot.
        await server.close();
        if (subscription !== undefined)
        {
            subscription.target.off('upgrade', subscription.forward);
            subscription = undefined;
        }
    };

    return { app, before, attach, close };
}
