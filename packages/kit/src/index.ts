/**
 * MODULE: kit - per-route rendering over @azerothjs/http (the node adapter)
 *
 * `mountPages(app, options)` is the assembled car's server half. It reads the SAME
 * route table the client router uses - code-first, nothing to learn - plus one
 * kit-recognized field per route:
 *
 *   render: 'server'   SSR per request (guards -> real 302s, parallel loaders ->
 *                      handoff, hydrated client-side). The default when a
 *                      renderer is provided.
 *   render: 'static'   prerendered at build (azeroth-kit-prerender); the server
 *                      serves the written file.
 *   render: 'client'   the SPA shell; the browser renders.
 *
 * Assets and unknown paths fall through to static file serving. The kit adds NO
 * routing system and NO data system: the table is the router's own, and the data
 * story is the router's loaders (matchAndLoad) - assembly, not invention.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { Route } from 'azerothjs';
import type { App, Handler, RequestContext } from '@azerothjs/http';
import { html as htmlResponse, NotFoundError } from '@azerothjs/http';
import { staticFiles } from '@azerothjs/http/node';
import { manifestScript, type Manifest } from '@azerothjs/http/api';

import type { PageRenderer } from './ssr.ts';
import { MemoryPageCache, pageResponse, registerIsr } from './isr.ts';
import type { KitErrorObserver, PageCache } from './isr.ts';
import { imageHandler } from './image.ts';
import type { ImageHandlerOptions } from './image.ts';

/** A route with the kit's per-route rendering mode. */
export interface PageRoute extends Route
{
    /**
     * How this path renders in production: `'server'` (SSR per request), `'static'`
     * (prerendered at build), `'client'` (SPA shell), `'stream'` (streaming SSR: the
     * shell flushes immediately, Suspense boundaries follow as they settle). Defaults
     * to `'server'` when {@link KitOptions.renderer} is provided, else `'client'`.
     */
    render?: 'server' | 'static' | 'client' | 'stream';

    /**
     * Enumerates the param sets a parameterized `'static'` route prerenders - the build
     * renders one file per set, and `mountPages` serves those files with unlisted params
     * falling through to the live renderer. The route table ships to the browser, so the
     * closure must stay browser-safe: inline data, or a dynamic import the client bundle
     * never follows eagerly.
     */
    staticParams?: () => Promise<Array<Record<string, string>>>;

    /**
     * ISR: how many seconds a cached copy of this `'static'` page stays fresh. Within the
     * window requests serve the cache; past it the stale copy is served WHILE one background
     * regeneration renders a replacement. Inherits down `children` like `render`.
     */
    revalidate?: number;

    /** Nested routes may carry modes too. */
    children?: PageRoute[];
}

/** The routes, client dist, and optional renderer {@link mountPages} needs. */
export interface KitOptions
{
    /** The route table - the same one the client router mounts. */
    routes: PageRoute[];

    /** The built client directory (vite's dist: assets, index.html shell, prerendered pages). */
    clientDir: string;

    /**
     * The per-url page renderer from the SSR bundle -
     * `createPageRenderer(App, routes)` re-exported by the app's server entry.
     * Omit for a fully static/client site.
     */
    renderer?: PageRenderer;

    /**
     * The api manifest (`manifestOf(api)`), embedded into every served page as an
     * inert JSON script tag so the typed client boots synchronously - no
     * `/api/_manifest` round trip on the hydration path. Omit and clients fall
     * back to fetching.
     */
    manifest?: Manifest;

    /** Where ISR pages live (default: one in-process {@link MemoryPageCache} per mount). */
    cache?: PageCache;

    /**
     * Enables GET /_image over the client dist: `true` for the defaults (no adapter -
     * cached originals), or the handler options minus `root`/`onError`, which this mount
     * provides. The endpoint registers BEFORE the asset fallback.
     */
    images?: true | Omit<ImageHandlerOptions, 'root' | 'onError'>;

    /**
     * Hears background failures (a failed ISR regeneration, a broken image transform) -
     * work with no request to answer. Default: console.error; kit carries no logger dep.
     */
    onError?: KitErrorObserver;

    /**
     * Supplies the per-request CSP nonce for the inline script and style tags a page emits.
     * Return the SAME nonce this request's Content-Security-Policy header carries, and list it
     * in BOTH directives - `script-src` and `style-src` - because it stamps both:
     *
     * - `render: 'stream'` inline scripts. REQUIRED under any `script-src` without
     *   `'unsafe-inline'`, or the browser blocks the swap runtime, every boundary sits on its
     *   fallback until hydration refetches, and the streamed bytes are wasted.
     * - the scoped-CSS `<style>` a server-rendered page carries. REQUIRED under any
     *   `style-src` without `'unsafe-inline'`, or the page paints unstyled until hydration.
     *
     * A policy that lists the nonce only under `script-src` leaves `style-src` falling back to
     * `default-src`, which refuses the stylesheet.
     */
    scriptNonce?: (context: RequestContext) => string | undefined;
}

/**
 * @internal Drops every trailing slash in one linear pass. The regex form (`/\/+$/`)
 * backtracks quadratically on a path made of slashes, and route paths are library input.
 */
function withoutTrailingSlashes(value: string): string
{
    let end = value.length;
    while (end > 0 && value[end - 1] === '/')
    {
        end--;
    }
    return value.slice(0, end);
}

/** One flattened page: the absolute path plus the effective per-route kit fields. */
export interface FlatPage
{
    path: string;
    render: PageRoute['render'];

    /** Leaf-only: enumeration never inherits - a parent's param list means nothing to a child. */
    staticParams?: PageRoute['staticParams'];
    revalidate?: number;
}

/** @internal Flattens the page tree to absolute paths with their effective modes. */
export function flattenPages(
    routes: PageRoute[],
    base = '',
    inherited: { render?: PageRoute['render'] | undefined; revalidate?: number | undefined } = {}
): FlatPage[]
{
    const out: FlatPage[] = [];
    for (const route of routes)
    {
        const child = route.path.startsWith('/') ? route.path.slice(1) : route.path;
        const full = base === ''
            ? withoutTrailingSlashes(`/${ child }`) || '/'
            : withoutTrailingSlashes(`${ base }/${ child }`);
        const mode = route.render ?? inherited.render;
        const revalidate = route.revalidate ?? inherited.revalidate;
        if (route.children !== undefined && route.children.length > 0)
        {
            out.push(...flattenPages(route.children, full === '/' ? '' : full, { render: mode, revalidate }));
        }
        else
        {
            const page: FlatPage = { path: full, render: mode };
            if (route.staticParams !== undefined)
            {
                page.staticParams = route.staticParams;
            }
            if (revalidate !== undefined)
            {
                page.revalidate = revalidate;
            }
            out.push(page);
        }
    }
    return out;
}

/** @internal A leading-slash path as the prerender output file inside clientDir. */
export function prerenderFileFor(path: string): string
{
    return path === '/' ? 'index.html' : `${ path.slice(1) }/index.html`;
}

/**
 * @internal The client shell, read once at mount and awaited per request. The rejection
 * handler is attached HERE, at creation: nothing awaits this promise until a request
 * arrives, and an unhandled rejection in the turn it happens TERMINATES the process - a
 * wrong clientDir was a crash loop reporting a bare ENOENT that named neither the
 * directory nor the kit. The requesting handler awaits the same promise and gets this
 * error instead.
 */
function loadShell(clientDir: string): Promise<string>
{
    const shell = readFile(join(clientDir, 'shell.html'), 'utf8')
        .catch(() => readFile(join(clientDir, 'index.html'), 'utf8'))
        .catch((cause: unknown) =>
        {
            throw new Error(`kit mountPages: no client shell in ${ clientDir } - looked for shell.html and index.html. `
                + 'Point clientDir at the built client (vite build output), or run the build first.', { cause });
        });
    shell.catch(() =>
    {
        // Handled here so the rejection is never unhandled; every reader awaits `shell` itself.
    });
    return shell;
}

/**
 * Registers every page route plus asset serving on the app. API routes registered
 * BEFORE this call keep priority for their exact paths; register `mountPages`
 * LAST so `/*path` asset fallback cannot shadow anything.
 */
export function mountPages(app: App, options: KitOptions): void
{
    // ONE splice point: the manifest rides the shell text, so every serving path -
    // the plain shell, and SSR output (the renderer builds from this same shell) -
    // carries it without any per-request work. Prerendered files were written at
    // build time without a server and keep the fetch fallback.
    const manifest = options.manifest;
    const shellPromise = manifest === undefined
        ? loadShell(options.clientDir)
        : loadShell(options.clientDir).then((shell) => shell.replace('</head>', () => `${ manifestScript(manifest) }</head>`));

    // Which build this process serves, hashed ONCE from the shell. A persistent page cache
    // outlives the deploy that filled it, and the HTML it holds names the previous build's
    // content-hashed assets - files the new build deleted - so ISR discards any entry stamped
    // with a different id. The shell is the right thing to hash because it CARRIES those asset
    // URLs: it changes exactly when they do.
    const buildIdPromise = shellPromise
        .then((shell) => createHash('sha256').update(shell).digest('hex').slice(0, 16))
        .catch(() => randomUUID());

    const assets = staticFiles(options.clientDir);
    const defaultMode: PageRoute['render'] = options.renderer !== undefined ? 'server' : 'client';
    const seedFile = (key: string): string | null =>
    {
        const file = resolve(options.clientDir, prerenderFileFor(key));
        const root = resolve(options.clientDir);
        return file.startsWith(root.endsWith(sep) ? root : `${ root }${ sep }`) ? file : null;
    };
    let isrCache: PageCache | undefined;

    for (const page of flattenPages(options.routes))
    {
        const mode = page.render ?? defaultMode;
        if (page.revalidate !== undefined)
        {
            if (mode !== 'static')
            {
                throw new Error(`kit mountPages: "${ page.path }" sets revalidate but renders '${ mode }' - `
                    + 'revalidate only means something for a static page.');
            }
            if (!Number.isFinite(page.revalidate) || page.revalidate <= 0)
            {
                throw new Error(`kit mountPages: "${ page.path }" revalidate must be a positive number of seconds, `
                    + `got ${ page.revalidate }.`);
            }
            if (options.renderer === undefined)
            {
                throw new Error(`kit mountPages: "${ page.path }" sets revalidate but no renderer was provided - `
                    + 'ISR regenerates through the SSR bundle\'s renderer.');
            }
            isrCache ??= options.cache ?? new MemoryPageCache();
            registerIsr({
                app,
                path: page.path,
                revalidate: page.revalidate,
                cache: isrCache,
                renderer: options.renderer,
                shell: shellPromise,
                seedFile,
                buildId: buildIdPromise,
                onError: options.onError ?? ((error, context): void =>
                {
                    console.error(`kit ${ context.phase } failed for ${ context.path }:`, error);
                })
            });
            continue;
        }
        if (page.path.includes(':') || page.path.includes('*'))
        {
            if (mode === 'static' && !page.path.includes('*'))
            {
                // An enumerated static page: try the prerendered file for the matched
                // params first, live-render anything the enumeration did not list.
                registerStaticFirst(app, page.path, options, shellPromise, assets);
            }
            else
            {
                // A wildcard cannot prerender one file: 'static' downgrades to
                // per-request SSR when a renderer exists, else to the shell.
                registerDynamic(app, page.path, mode === 'static' ? defaultMode : mode, options, shellPromise);
            }
            continue;
        }
        if (mode === 'static')
        {
            const file = prerenderFileFor(page.path);
            app.get(page.path, staticFiles(options.clientDir, { index: file, param: '__none' }));
        }
        else
        {
            registerDynamic(app, page.path, mode, options, shellPromise);
        }
    }

    if (options.images !== undefined)
    {
        app.get('/_image', imageHandler({
            root: options.clientDir,
            ...(options.onError !== undefined ? { onError: options.onError } : {}),
            ...(options.images === true ? {} : options.images)
        }));
    }

    // Vite's hashed build output is immutable by construction - the second mount
    // StaticOptions documents, with the headers the hashes earn.
    const assetsDir = join(options.clientDir, 'assets');
    if (existsSync(assetsDir))
    {
        app.get('/assets/*path', staticFiles(assetsDir, { cacheControl: 'public, max-age=31536000, immutable' }));
    }

    // Everything else is an asset (favicons, prerendered files, public/ copies).
    app.get('/*path', assets);
}

/** @internal The SSR-or-shell response for one request - shared by every dynamic path. */
async function renderOrShell(
    context: RequestContext,
    mode: PageRoute['render'],
    options: KitOptions,
    shell: string
): Promise<Response>
{
    if (mode === 'server' && options.renderer !== undefined)
    {
        // The nonce reaches the buffered path too, not just the streamed one: a server-rendered
        // page carries the scoped-CSS <style>, and without the nonce a strict `style-src`
        // refuses it and the page paints unstyled until hydration.
        const nonce = options.scriptNonce?.(context);
        const result = await options.renderer(
            context.url.pathname + context.url.search,
            shell,
            nonce === undefined ? undefined : { scriptNonce: nonce });
        return pageResponse(result, shell);
    }
    return htmlResponse(shell);
}

/** @internal An SSR-or-shell handler for one path; `'stream'` answers a streaming Response. */
function registerDynamic(
    app: App,
    path: string,
    mode: PageRoute['render'],
    options: KitOptions,
    shellPromise: Promise<string>
): void
{
    app.get(path, async (context) =>
    {
        const shell = await shellPromise;
        if (mode === 'stream' && options.renderer !== undefined)
        {
            // HEAD gets the buffered path: the kernel strips the body anyway, and a plain
            // string-mode render starts no server fetches at all.
            if (context.request.method === 'HEAD')
            {
                return renderOrShell(context, 'server', options, shell);
            }
            const nonce = options.scriptNonce?.(context);
            const result = await options.renderer(
                context.url.pathname + context.url.search,
                shell,
                {
                    stream: true,
                    signal: context.request.signal,
                    ...(nonce !== undefined ? { scriptNonce: nonce } : {})
                });
            if (result.kind === 'stream')
            {
                // A genuine web Response: Node's adapter pumps it with backpressure and
                // Bun/Deno's bridges pass it through untouched. Never a content-length.
                //
                // `x-accel-buffering: no` carries the anti-buffering intent. Deliberately NOT
                // `no-transform`: that directive is a per-response opt-out an APPLICATION sets,
                // and compressResponse honours it - so setting it here silently opted every
                // streamed page out of the per-chunk-flushed compression that exists for
                // precisely this response shape, with no header revealing the loss.
                return new Response(result.stream, {
                    status: result.status,
                    headers: {
                        'content-type': 'text/html; charset=utf-8',
                        'cache-control': 'no-cache',
                        'x-accel-buffering': 'no'
                    }
                });
            }
            // A renderer unaware of the streaming option (or a redirect/veto, which stay
            // buffered by design) answered with an ordinary result: serve it as such.
            return pageResponse(result, shell);
        }
        return renderOrShell(context, mode, options, shell);
    });
}

/** @internal A prerendered-file-first handler for an enumerated static pattern. */
function registerStaticFirst(
    app: App,
    path: string,
    options: KitOptions,
    shellPromise: Promise<string>,
    assets: Handler
): void
{
    const dynamicMode: PageRoute['render'] = options.renderer !== undefined ? 'server' : 'client';
    app.get(path, async (context) =>
    {
        try
        {
            // context.path is the router's decoded matched path - the exact string the
            // prerender pass resolved, so the lookup and the write agree by construction.
            // A fresh object (not a merge) carries the file path, so staticFiles' full
            // machinery (containment, ETag, ranges) serves the prerendered bytes.
            return await assets({ ...context, params: { path: prerenderFileFor(context.path) } });
        }
        catch (error)
        {
            if (!(error instanceof NotFoundError))
            {
                throw error;
            }
        }
        return renderOrShell(context, dynamicMode, options, await shellPromise);
    });
}

export { FilePageCache, MemoryPageCache } from './isr.ts';
export type { KitErrorObserver, PageCache, PageEntry } from './isr.ts';
export { MemoryImageCache, imageHandler } from './image.ts';
export type { ImageAdapter, ImageCache, ImageCacheEntry, ImageHandlerOptions } from './image.ts';
export type { PageRenderOptions, PageRenderer, PageResult } from './ssr.ts';
