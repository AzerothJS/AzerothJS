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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Route } from 'azerothjs';
import type { App } from '@azerothjs/http';
import { html as htmlResponse } from '@azerothjs/http';
import { staticFiles } from '@azerothjs/http/node';

import type { PageRenderer } from './ssr.ts';

/** A route with the kit's per-route rendering mode. */
export interface PageRoute extends Route
{
    /**
     * How this path renders in production: `'server'` (SSR per request),
     * `'static'` (prerendered at build), `'client'` (SPA shell). Defaults to
     * `'server'` when {@link KitOptions.renderer} is provided, else `'client'`.
     */
    render?: 'server' | 'static' | 'client';

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
}

/** @internal Flattens the page tree to absolute paths with their effective modes. */
export function flattenPages(routes: PageRoute[], base = '', inherited?: PageRoute['render']): Array<{ path: string; render: PageRoute['render'] }>
{
    const out: Array<{ path: string; render: PageRoute['render'] }> = [];
    for (const route of routes)
    {
        const child = route.path.startsWith('/') ? route.path.slice(1) : route.path;
        const full = base === '' ? `/${ child }`.replace(/\/+$/, '') || '/' : `${ base }/${ child }`.replace(/\/+$/, '');
        const mode = route.render ?? inherited;
        if (route.children !== undefined && route.children.length > 0)
        {
            out.push(...flattenPages(route.children, full === '/' ? '' : full, mode));
        }
        else
        {
            out.push({ path: full, render: mode });
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
 * Registers every page route plus asset serving on the app. API routes registered
 * BEFORE this call keep priority for their exact paths; register `mountPages`
 * LAST so `/*path` asset fallback cannot shadow anything.
 */
export function mountPages(app: App, options: KitOptions): void
{
    const shellPromise = readFile(join(options.clientDir, 'shell.html'), 'utf8')
        .catch(() => readFile(join(options.clientDir, 'index.html'), 'utf8'));

    const assets = staticFiles(options.clientDir);
    const defaultMode: PageRoute['render'] = options.renderer !== undefined ? 'server' : 'client';

    for (const page of flattenPages(options.routes))
    {
        const mode = page.render ?? defaultMode;
        if (page.path.includes(':') || page.path.includes('*'))
        {
            // A parameterized page cannot prerender one file: a declared (or
            // inherited) 'static' downgrades to per-request SSR when a renderer
            // exists, else to the shell.
            registerDynamic(app, page.path, mode === 'static' ? defaultMode : mode, options, shellPromise);
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

    // Everything else is an asset (hashed js/css, favicons, images).
    app.get('/*path', assets);
}

/** @internal An SSR-or-shell handler for one path. */
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
        if (mode === 'server' && options.renderer !== undefined)
        {
            const result = await options.renderer(context.url.pathname + context.url.search, shell);
            if (result.kind === 'redirect')
            {
                return new Response(null, { status: 302, headers: { location: result.to } });
            }
            // A vetoed route renders NOTHING: serve the plain shell (so the client can boot
            // and show its own 403 UI) with the guard's status - never the protected page.
            if (result.kind === 'blocked')
            {
                return htmlResponse(shell, { status: result.status });
            }
            return htmlResponse(result.html, { status: result.status });
        }
        return htmlResponse(shell);
    });
}

export type { PageRenderer, PageResult } from './ssr.ts';
