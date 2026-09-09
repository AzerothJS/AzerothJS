/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Per-route rendering over @azerothjs/http (the node adapter).
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

import type { NavigateTarget, Route } from 'azerothjs';
import { localeDirection, negotiateLocale } from 'azerothjs';
import type { NegotiatedLocale } from 'azerothjs';
import { acceptRedirectTarget, evaluateGuardsForPattern, guardedMatch, isRedirect, targetToFullPath } from 'azerothjs/internal';
import type { App, Handler, RequestContext } from '@azerothjs/http';
import { html as htmlResponse, json as jsonResponse, readForm, verifyCsrfField, csrfToken, serializeCookie, parseCookies, CSRF_FIELD, ForbiddenError, NotFoundError, UnauthorizedError } from '@azerothjs/http';
import type { CsrfOptions } from '@azerothjs/http';
import { staticFiles } from '@azerothjs/http/node';
import { manifestScript, type Manifest } from '@azerothjs/http/api';

import type { PageRenderer } from './ssr.ts';
import { applyLocaleToShell } from './ssr.ts';
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

    /**
     * What a form on this page POSTs to. Declared on the ROUTE because the route already owns
     * the read (its loader) and the write belongs beside it.
     *
     * This is the no-JS path: a plain `<form method="post">` needs no fetch, no bundle and no
     * event handler, and `mountPages` registers a POST for the page's own path so the page can
     * receive the form it renders. Without one it cannot - the mount is GET-only, and a submit
     * answers 405.
     *
     * Returning `undefined` means the write succeeded: the response is a 303 back to this same
     * URL, so the loader re-runs, the page shows the change, and a refresh cannot re-submit it
     * (POST/Redirect/GET). Returning a VALUE means it did not: the page re-renders at 422 with
     * that value readable through `useActionResult()`, which is where field errors go. Throwing
     * `redirect(...)` sends the visitor somewhere else entirely.
     *
     * CSRF is enforced before the action runs, and the form must carry the token in a hidden
     * `_csrf` field, since a plain form cannot set a header.
     */
    action?: (context: PageActionContext) => Promise<unknown>;

    /** Nested routes may carry modes too. */
    children?: PageRoute[];
}

/** What a {@link PageRoute.action} receives. */
export interface PageActionContext
{
    /** The submitted fields, repeated keys preserved. */
    form: URLSearchParams;

    /** The path params of the URL that was posted to. */
    params: Record<string, string>;

    /** The submitting request, for cookies, headers and identity. */
    request: Request;

    /** The posted URL. */
    url: URL;
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
     * The languages this site is published in. Given these, every page is negotiated per request
     * and served with its own `<html lang>` and `<html dir>`.
     *
     * Without it nothing is negotiated and the shell's own `<html>` stands, which is correct for
     * a single-language site and wrong the moment there are two - a shell says one language and a
     * request can be for another.
     */
    locales?: {
        /** BCP 47 tags, best first. The first is used when nothing else matches. */
        supported: readonly string[];

        /** Served when the reader asks for nothing this site publishes. Defaults to `supported[0]`. */
        default?: string;

        /**
         * The cookie holding a reader's explicit choice, which outranks their browser's headers.
         * Defaults to `locale`, the name `setLocale()` writes.
         */
        cookie?: string;

        /**
         * How a language is expressed in the url.
         *
         * `'negotiate'` (the default) keeps one url per page and decides per request. Simple, and
         * it is what a site with a language switcher and no search-engine ambitions wants.
         *
         * `'prefix'` gives every language its own url - `/fa/about` beside `/en/about` - and
         * redirects the unprefixed path to the reader's own. This is what search engines require:
         * `hreflang` annotations only mean anything between DISTINCT urls, so they are emitted
         * only in this mode. It also makes every page cacheable by a shared cache without `Vary`,
         * since the url alone now says which document it is.
         */
        routing?: 'negotiate' | 'prefix';
    };

    /**
     * Enables GET /_image over the client dist: `true` for the defaults (no adapter -
     * cached originals), or the handler options minus `root`/`onError`, which this mount
     * provides. The endpoint registers BEFORE the asset fallback.
     */
    images?: true | Omit<ImageHandlerOptions, 'root' | 'onError'>;

    /**
     * Hears background failures (a failed ISR regeneration, a broken image transform) -
     * work with no request to answer - plus one POLICY notice: the first time an ISR
     * registration meets a URL matching a guarded route chain, it reports (once, phase
     * 'revalidate') that those URLs render live and are never cached. Default:
     * console.error; kit carries no logger dep.
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

    /**
     * The cookie name and allowed origins a page ACTION verifies its CSRF token against - the
     * same options `csrfProtect` takes, so a mount and its api guard share one
     * configuration. Defaults match `csrfCookie`, which is what the scaffolded server
     * installs.
     */
    csrf?: CsrfOptions;
}

/**
 * @internal The mount's failure observer, defaulted in ONE place. The ISR path had the
 * console.error default the option documents while the render paths used `options.onError?.()`,
 * so an app that wired nothing lost every render-time failure in silence - including a loader
 * fault, whose 500 is otherwise the only trace it leaves anywhere.
 */
function observerFor(options: KitOptions): KitErrorObserver
{
    return options.onError ?? ((error, context): void =>
    {
        console.error(`kit ${ context.phase } failed for ${ context.path }:`, error);
    });
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

    /** What a form on this page posts to; see {@link PageRoute.action}. */
    action?: PageRoute['action'];

    /**
     * The joined path of the TOPMOST guard-carrying route in this page's chain, when any
     * route on it has a guard. A guard makes the render identity-dependent, and every
     * static serving shape (prerendered file, ISR cache) answers without running guards -
     * so the static refusals key on this, and its value lets the error name the route
     * that carries the guard rather than the page that merely inherits it.
     */
    guardedBy?: string;
}

/** @internal Flattens the page tree to absolute paths with their effective modes. */
export function flattenPages(
    routes: PageRoute[],
    base = '',
    inherited: { render?: PageRoute['render'] | undefined; revalidate?: number | undefined; guardedBy?: string | undefined } = {}
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
        const guardedBy = inherited.guardedBy ?? (route.guard !== undefined ? full : undefined);
        if (route.children !== undefined && route.children.length > 0)
        {
            // An action belongs to the page a form is rendered on, and a layout is not a page: it
            // has no path of its own to post to. Refused here, where mount and build both walk,
            // rather than dropped silently.
            if (route.action !== undefined)
            {
                throw new Error(`kit: "${ full }" declares an action but has children - an action belongs to the `
                    + 'page a form is rendered on, and a layout is not a page. Declare it on the leaf route.');
            }
            out.push(...flattenPages(route.children, full === '/' ? '' : full, { render: mode, revalidate, guardedBy }));
        }
        else
        {
            const page: FlatPage = { path: full, render: mode };
            if (route.action !== undefined)
            {
                page.action = route.action;
            }
            if (route.staticParams !== undefined)
            {
                page.staticParams = route.staticParams;
            }
            if (revalidate !== undefined)
            {
                page.revalidate = revalidate;
            }
            if (guardedBy !== undefined)
            {
                page.guardedBy = guardedBy;
            }
            out.push(page);
        }
    }
    return out;
}

/**
 * @internal A leading-slash path as the prerender output file inside clientDir.
 *
 * A multilingual build writes one file per language beside each other - `about/index.fa.html`
 * next to `about/index.html` - so a static page has a real artifact for every reader rather than
 * one language's copy served to all of them. The unsuffixed name stays exactly what it was, so a
 * single-language build is byte-identical and vite's own `index.html` is never shadowed.
 */
export function prerenderFileFor(path: string, locale?: string): string
{
    const name = locale === undefined ? 'index.html' : `index.${ locale }.html`;
    return path === '/' ? name : `${ path.slice(1) }/${ name }`;
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
    const rawShellPromise = loadShell(options.clientDir);
    const shellPromise = manifest === undefined
        ? rawShellPromise
        : rawShellPromise.then((shell) => shell.replace('</head>', () => `${ manifestScript(manifest) }</head>`));

    // Which build this process serves, hashed ONCE from the RAW shell - before any manifest
    // injection, so the prerender pass (which hashes the same file at build time) and this
    // mount agree on the id. A persistent page cache outlives the deploy that filled it, and
    // the HTML it holds names the previous build's content-hashed assets - files the new
    // build deleted - so ISR discards any entry stamped with a different id. The shell is
    // the right thing to hash because it CARRIES those asset URLs: it changes exactly when
    // they do.
    const buildIdPromise = rawShellPromise
        .then((shell) => createHash('sha256').update(shell).digest('hex').slice(0, 16))
        .catch(() => randomUUID());

    const report = observerFor(options);
    const assets = staticFiles(options.clientDir);
    const defaultMode: PageRoute['render'] = options.renderer !== undefined ? 'server' : 'client';
    const seedFile = (key: string): string | null =>
    {
        const file = resolve(options.clientDir, prerenderFileFor(key));
        const root = resolve(options.clientDir);
        return file.startsWith(root.endsWith(sep) ? root : `${ root }${ sep }`) ? file : null;
    };
    let isrCache: PageCache | undefined;

    // In prefix mode a page exists once per language and the bare path redirects to the
    // reader's own, so there is exactly ONE canonical url per (page, language) - which is what
    // hreflang annotates and what stops the same content being indexed twice.
    const mountPaths = (path: string): string[] => mountedPaths(path, options);

    for (const page of flattenPages(options.routes))
    {
        const mode = page.render ?? defaultMode;
        // A page action is a function of the request - its form carries a token minted for that
        // response - and a prerendered or cached page has no request. Same exemption as the
        // guard rule: a wildcard without revalidate downgrades to per-request SSR.
        if (mode === 'static' && page.action !== undefined
            && !(page.path.includes('*') && page.revalidate === undefined))
        {
            throw new Error(`kit mountPages: "${ page.path }" renders 'static' but declares an action - a `
                + 'prerendered or cached page carries no per-request token, so its form cannot submit '
                + 'without JavaScript. Use render: \'server\' for a page that receives a form.');
        }
        // A guarded chain makes the render identity-dependent, and every 'static' serving
        // shape answers without running guards: a prerendered file involves no renderer at
        // all, and an ISR cache hit answers without any routing. Refused at mount so a server-only
        // upgrade against an old dist fails the DEPLOY loudly instead of serving stale
        // guarded files forever. The one exemption: a wildcard WITHOUT revalidate never
        // serves files (it downgrades to per-request SSR, where guards run, or to the bare
        // shell, which carries no content).
        if (mode === 'static' && page.guardedBy !== undefined
            && !(page.path.includes('*') && page.revalidate === undefined))
        {
            throw new Error(`kit mountPages: "${ page.path }" renders 'static' but its route chain `
                + `is guarded at "${ page.guardedBy }" - a prerendered or cached page is served without `
                + 'running guards. Move the guard into a server-rendered subtree, throw redirect() '
                + 'from a loader (live-rendered requests only; it never runs for prerendered bytes), '
                + 'or use render: \'server\'.');
        }
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
            for (const mounted of mountPaths(page.path))
            {
                registerIsr({
                    app,
                    path: mounted,
                    revalidate: page.revalidate,
                    guarded: (url) => guardedMatch(options.routes, url),
                    cache: isrCache,
                    renderer: options.renderer,
                    shell: shellPromise,
                    seedFile,
                    buildId: buildIdPromise,
                    onError: report,
                    locale: (request: Request, pathname: string) => localeFor(request, options, pathname),
                    vary: (request: Request, pathname: string) => varyFor(request, options, pathname),
                    strip: (pathname: string) => splitLocalePath(pathname, options).path
                });
            }
            registerLocaleRedirect(app, page.path, options);
            continue;
        }
        if (page.path.includes(':') || page.path.includes('*'))
        {
            if (mode === 'static' && !page.path.includes('*'))
            {
                // An enumerated static page: try the prerendered file for the matched
                // params first, live-render anything the enumeration did not list.
                for (const mounted of mountPaths(page.path))
                {
                    registerStaticFirst(app, mounted, options, shellPromise, assets, buildIdPromise);
                }
                registerLocaleRedirect(app, page.path, options);
            }
            else
            {
                // A wildcard cannot prerender one file: 'static' downgrades to
                // per-request SSR when a renderer exists, else to the shell.
                for (const mounted of mountPaths(page.path))
                {
                    registerDynamic(app, mounted, mode === 'static' ? defaultMode : mode, options, shellPromise, buildIdPromise);
                }
                registerLocaleRedirect(app, page.path, options);
            }
            continue;
        }
        if (mode === 'static')
        {
            const plain = prerenderFileFor(page.path);
            const localized = localesOf(options);
            if (localized.length === 0)
            {
                app.get(page.path, staticFiles(options.clientDir, { index: plain, param: '__none' }));
            }
            else
            {
                // One handler that picks this reader's file, falling back to the unsuffixed one
                // so a build that predates the locale config still serves.
                const servers = new Map<string, Handler>(localized.map((tag) =>
                    [tag, staticFiles(options.clientDir, { index: prerenderFileFor(page.path, tag), param: '__none' })]));
                const fallback = staticFiles(options.clientDir, { index: plain, param: '__none' });
                const staticHandler = async (context: RequestContext): Promise<Response> =>
                {
                    const tag = localeFor(context.request, options, context.url.pathname);
                    const server = tag === undefined ? undefined : servers.get(tag);
                    try
                    {
                        return withVary(await (server ?? fallback)(context), context, options);
                    }
                    catch (error)
                    {
                        if (!(error instanceof NotFoundError) || server === undefined)
                        {
                            throw error;
                        }
                        return withVary(await fallback(context), context, options);
                    }
                };
                for (const mounted of mountPaths(page.path))
                {
                    app.get(mounted, staticHandler);
                }
                registerLocaleRedirect(app, page.path, options);
            }
        }
        else
        {
            for (const mounted of mountPaths(page.path))
            {
                registerDynamic(app, mounted, mode, options, shellPromise, buildIdPromise);
            }
            registerLocaleRedirect(app, page.path, options);
        }
    }

    // The POST half, registered for exactly the pages that declare an action. A page with no
    // action keeps answering 405, which is the honest response: nothing there accepts a write.
    for (const page of flattenPages(options.routes))
    {
        if (page.action !== undefined)
        {
            registerAction(app, page, page.action, options, shellPromise, buildIdPromise, report);
        }
    }

    if (options.images !== undefined)
    {
        app.get('/_image', imageHandler({
            root: options.clientDir,
            onError: report,
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

    // Everything else is an asset (favicons, prerendered files, public/ copies) - or, when no
    // such file exists, a navigation to a URL this app does not route. The renderer already
    // answers that with the app's own fallback UI at a real 404, and the client router renders
    // the same `<Routes fallback>` for it; without this the branch was unreachable and the two
    // modes disagreed, a deep link to a stale path getting the asset handler's JSON error where
    // an in-app navigation got the 404 page. Negotiated on Accept, so a missing image or a
    // fetch() still gets the JSON its caller can read.
    app.get('/*path', async (context) =>
    {
        try
        {
            return await assets(context);
        }
        catch (error)
        {
            if (!(error instanceof NotFoundError) || !acceptsHtml(context.request))
            {
                throw error;
            }
        }
        return renderOrShell(context, defaultMode, options, await shellPromise, buildIdPromise, 404);
    });
}

/** @internal Splits an app path into its pathname and search, the two the guard walk needs. */
function splitPath(full: string): { pathname: string; search: string }
{
    const at = full.indexOf('?');
    return at < 0 ? { pathname: full, search: '' } : { pathname: full.slice(0, at), search: full.slice(at) };
}

/**
 * @internal The paths one page is mounted at: its own, plus one per language prefix when the
 * site gives each language its own url.
 */
function mountedPaths(path: string, options: KitOptions): string[]
{
    const prefixes = localePrefixes(options);
    return prefixes.length === 0 ? [path] : prefixes.map((tag) => (path === '/' ? `/${ tag }` : `/${ tag }${ path }`));
}

/**
 * @internal Runs one page action for a form submit.
 *
 * The order is load-bearing. The body is read FIRST because the CSRF token arrives in it - a
 * plain form cannot set a header - and the token is checked before anything else runs, so a
 * cross-site submit never reaches a guard or the action. The route chain's GUARDS run next,
 * through the same walk the page's GET runs, so a write is gated by exactly what gates the page
 * it belongs to. On success the answer is a 303 rather than rendered markup: that is what stops
 * a refresh from re-posting, and it makes the loader the single source of what the page then
 * shows.
 *
 * Registered at the page's bare path AND its language-prefixed ones: the bare path is what a
 * rendered form targets today, the prefixed ones are what the browser url and the enhanced
 * submit target.
 */
function registerAction(
    app: App,
    page: FlatPage,
    action: NonNullable<PageRoute['action']>,
    options: KitOptions,
    shellPromise: Promise<string>,
    buildId: Promise<string>,
    report: KitErrorObserver
): void
{
    const handler = async (context: RequestContext): Promise<Response> =>
    {
        const form = await readForm(context.request);
        verifyCsrfField(context.request, context.url, form.get(CSRF_FIELD), options.csrf ?? {});
        // The token is not the application's business, and leaving it in would put it in front
        // of every schema that validates the submitted fields.
        form.delete(CSRF_FIELD);

        // One action, two representations, chosen by what the client asked for. A NATIVE form
        // submit is a navigation and needs the redirect-then-render dance; an enhanced submit is
        // a fetch that wants the value, and following a 303 to re-download the page it is
        // already showing would defeat the point of intercepting it.
        const wantsJson = acceptsJson(context.request);
        const fullPathOf = (to: NavigateTarget): string => (typeof to === 'string' ? to : targetToFullPath(to));
        const sendTo = (location: string): Response => (wantsJson
            ? jsonResponse({ ok: true, redirect: location }, { headers: { 'cache-control': 'private, no-store' } })
            : seeOther(location));

        // The chain's guards, selected by the pattern this POST was REGISTERED for rather than by
        // re-deriving a chain from the request url. The two are not the same string: the kernel
        // dispatches on one spelling and a url walk would select on another, and every spelling
        // they disagree about (`%2e%2e`, a percent-encoded locale prefix, a static sibling
        // declared after a param one, a doubled trailing slash) would run this page's write under
        // some other page's guards, or none at all. The params are the ones the kernel bound for
        // this request, so the guard sees what the handler sees.
        const { pathname, search } = splitPath(appPath(context, options));
        const walked = await evaluateGuardsForPattern(options.routes, page.path, { params: context.params, pathname, search });
        if (walked.kind === 'not-found')
        {
            throw new NotFoundError();
        }
        if (walked.kind === 'blocked')
        {
            // A JSON client gets the kernel's refusal, the envelope the CSRF check on this same
            // path answers with. A native submit gets the page's own blocked UI at the guard's
            // status: the render runs the same walk and yields the blocked result the page's
            // GET shows, so the two arrivals agree.
            const refusal = walked.status === 401
                ? new UnauthorizedError('Sign in to submit this form.')
                : new ForbiddenError('This form is not available to you.');
            const renderer = options.renderer;
            if (wantsJson || renderer === undefined)
            {
                throw refusal;
            }
            // The page's own blocked UI, rendered through the renderer - which reaches the verdict
            // itself and pins the render to it. If it reaches a DIFFERENT verdict (a renderer
            // built over another table), its answer is not this refusal and must not be served:
            // that is the shape where a blocked POST would come back 200 carrying the protected
            // page. The kernel refusal is the fallback, so the write is refused either way.
            const locale = localeFor(context.request, options, context.url.pathname);
            const rendered = await renderer(appPath(context, options), await shellPromise, {
                signal: context.request.signal,
                handoffMeta: { build: await buildId, at: Date.now() },
                ...(locale !== undefined ? { locale } : {})
            });
            if (rendered.kind !== 'blocked')
            {
                throw refusal;
            }
            return withVary(pageResponse(rendered, await shellPromise), context, options);
        }
        if (walked.kind === 'refused-redirect')
        {
            throw new Error(`kit: a guard on "${ page.path }" redirected off-origin to "${ walked.target }" during a `
                + 'form submit - a redirect target that leaves the app\'s origin is refused; redirect to a path, '
                + 'or wrap a deliberate off-origin target in unsafeUrl(...).');
        }
        if (walked.kind === 'redirect')
        {
            return sendTo(fullPathOf(walked.to));
        }

        let result: unknown;
        try
        {
            result = await action({ form, params: context.params, request: context.request, url: context.url });
        }
        catch (error)
        {
            if (isRedirect(error))
            {
                // The one redirect boundary the router does not judge itself, so it is judged
                // here by the same rule as the other three.
                const judged = acceptRedirectTarget(error.to);
                if (!judged.accepted)
                {
                    throw new Error(`kit: the action on "${ page.path }" redirected off-origin to "${ judged.target }" - `
                        + 'a redirect target that leaves the app\'s origin is refused; redirect to a path, or wrap '
                        + 'a deliberate off-origin target in unsafeUrl(...).', { cause: error });
                }
                return sendTo(fullPathOf(judged.to));
            }
            throw error;
        }
        if (result === undefined)
        {
            // POST/Redirect/GET: the visitor lands on a GET, so a refresh re-reads instead of
            // re-writing, and the browser's back button does not offer to resubmit.
            return wantsJson
                ? jsonResponse({ ok: true }, { headers: { 'cache-control': 'private, no-store' } })
                : seeOther(context.url.pathname + context.url.search);
        }
        if (wantsJson)
        {
            return jsonResponse({ ok: false, result }, { status: 422, headers: { 'cache-control': 'private, no-store' } });
        }
        // A returned value is a REFUSAL - the classic validation re-render. The page renders
        // again at 422 with the value in hand, which is where field errors reach the form.
        return renderOrShell(
            context,
            options.renderer !== undefined ? 'server' : 'client',
            options,
            await shellPromise,
            buildId,
            422,
            { result, report });
    };
    for (const mounted of new Set([page.path, ...mountedPaths(page.path, options)]))
    {
        app.post(mounted, handler);
    }
}

/** @internal The POST/Redirect/GET answer. 303 so the follow-up is a GET on every client. */
function seeOther(location: string): Response
{
    return new Response(null, { status: 303, headers: { location, 'cache-control': 'private, no-store' } });
}

/**
 * @internal This request's CSRF token, and whether it had to be minted.
 *
 * A form needs the token WHILE RENDERING, and on a visitor's first page load there is no
 * cookie yet - so one is minted here and the same value both goes into the markup and comes
 * back as a Set-Cookie. Waiting for `csrfCookie` to mint on the way out would put a token in
 * the browser that the form on that very page does not carry, and every first submit would
 * fail its own check.
 */
function tokenFor(request: Request, options: KitOptions): { token: string; minted: boolean }
{
    const name = options.csrf?.cookie ?? (options.csrf?.secure === false ? 'azcsrf' : '__Host-azcsrf');
    const existing = parseCookies(request)[name];
    return existing === undefined ? { token: csrfToken(), minted: true } : { token: existing, minted: false };
}

/**
 * @internal The language to serve this request in, or undefined when the site declares none.
 *
 * A cookie is an answer the reader gave; `Accept-Language` is what their browser guesses on
 * their behalf. So an explicit choice wins outright, and only in its absence is the header
 * negotiated - in preference order, which is the half hand-rolled detectors get wrong.
 */
function localeFor(request: Request, options: KitOptions, pathname?: string): string | undefined
{
    return negotiate(request, options, pathname)?.locale;
}

/**
 * @internal Sends the unprefixed path to the reader's own language.
 *
 * A no-op outside prefix mode. Inside it, this is the ONE place negotiation still happens: the
 * reader's cookie or headers choose which language they are sent to, and every url after that
 * names its own language. 302 rather than 301, because the answer depends on who is asking and a
 * permanent redirect would be cached by the browser for everyone who follows.
 */
function registerLocaleRedirect(app: App, path: string, options: KitOptions): void
{
    const prefixes = localePrefixes(options);
    if (prefixes.length === 0)
    {
        return;
    }
    app.get(path, (context) =>
    {
        const tag = negotiate(context.request, options)?.locale ?? prefixes[0] ?? '';
        const target = (path === '/' ? `/${ tag }` : `/${ tag }${ context.url.pathname }`) + context.url.search;
        return new Response(null, {
            status: 302,
            headers: {
                location: target,
                // The target depends on the reader, so a shared cache must not replay one
                // reader's redirect for the next.
                vary: 'accept-language, cookie',
                'cache-control': 'private, no-store'
            }
        });
    });
}

/** @internal The language prefixes this mount routes under, or none (negotiate mode). */
function localePrefixes(options: KitOptions): readonly string[]
{
    return options.locales?.routing === 'prefix' ? options.locales.supported : [];
}

/**
 * @internal Splits `/fa/about` into the language and the APP path `/about`.
 *
 * The route table, the prerendered file names and the client router all speak unprefixed paths,
 * so the prefix is peeled off once, here, and everything downstream is unchanged by the mode.
 */
function splitLocalePath(pathname: string, options: KitOptions): { locale?: string; path: string }
{
    for (const tag of localePrefixes(options))
    {
        if (pathname === `/${ tag }`)
        {
            return { locale: tag, path: '/' };
        }
        if (pathname.startsWith(`/${ tag }/`))
        {
            return { locale: tag, path: pathname.slice(tag.length + 1) };
        }
    }
    return { path: pathname };
}

/**
 * @internal Every language this page exists in, as absolute urls.
 *
 * Empty outside prefix mode, deliberately: hreflang annotates a RELATIONSHIP BETWEEN URLS, and a
 * set of them all pointing at one negotiated address says nothing a crawler can act on. Emitting
 * them there would be worse than omitting them, because it looks like the page is annotated.
 *
 * `x-default` names the unprefixed path - the one that negotiates - which is exactly what that
 * annotation is for: where to send a reader whose language the site does not publish.
 */
function alternatesFor(context: RequestContext, options: KitOptions): Array<{ hreflang: string; href: string }>
{
    const prefixes = localePrefixes(options);
    if (prefixes.length === 0)
    {
        return [];
    }
    const { path } = splitLocalePath(context.url.pathname, options);
    const origin = context.url.origin;
    const search = context.url.search;
    const alternates = prefixes.map((tag) => ({
        hreflang: tag,
        href: `${ origin }${ path === '/' ? `/${ tag }` : `/${ tag }${ path }` }${ search }`
    }));
    alternates.push({ hreflang: 'x-default', href: `${ origin }${ path }${ search }` });
    return alternates;
}

/** @internal The app path this request renders, with any language prefix removed. */
function appPath(context: RequestContext, options: KitOptions): string
{
    return splitLocalePath(context.url.pathname, options).path + context.url.search;
}

/**
 * @internal The languages this mount publishes, or none.
 */
function localesOf(options: KitOptions): readonly string[]
{
    return options.locales?.supported ?? [];
}

/**
 * @internal What a negotiated response varies on.
 *
 * `Accept-Language` always participates once a site publishes more than one language. The COOKIE
 * only joins when this reader actually has one, and saying so per-response matters: naming it
 * unconditionally would make every page uncacheable by a shared cache for the sake of readers who
 * never chose, while omitting it when it decided the answer lets a CDN serve one reader's chosen
 * language to another.
 */
function varyFor(request: Request, options: KitOptions, pathname?: string): string | undefined
{
    if (pathname !== undefined && splitLocalePath(pathname, options).locale !== undefined)
    {
        // The url already names the language, so this response is the same for every reader who
        // asks for it - which is the whole reason prefix routing exists for a cached site.
        return undefined;
    }
    const negotiated = negotiate(request, options);
    if (negotiated === undefined)
    {
        return undefined;
    }
    return negotiated.fromCookie ? 'accept-language, cookie' : 'accept-language';
}

function negotiate(request: Request, options: KitOptions, pathname?: string): NegotiatedLocale | undefined
{
    const config = options.locales;
    if (config === undefined || config.supported.length === 0)
    {
        return undefined;
    }
    // In prefix mode the URL says which document this is, so nothing is negotiated and nothing
    // varies: the language is already part of what was asked for.
    if (pathname !== undefined)
    {
        const fromPath = splitLocalePath(pathname, options).locale;
        if (fromPath !== undefined)
        {
            return { locale: fromPath, fromCookie: false };
        }
    }
    // The SAME rule any handler can call, rather than a copy that would drift from it: a site
    // whose API answers in a different language from its pages is worse than one that only
    // speaks English.
    return negotiateLocale(request, config);
}

/**
 * @internal Declares what a negotiated response varies on, without disturbing an existing Vary.
 *
 * A response body that depends on a request header is only safely shared if every cache in front
 * of it is told which header. Our own page cache keys on the resolved language directly; this is
 * for the ones we do not control.
 */
function withVary(response: Response, context: RequestContext, options: KitOptions): Response
{
    const vary = varyFor(context.request, options, context.url.pathname);
    if (vary === undefined)
    {
        return response;
    }
    const existing = response.headers.get('vary');
    const merged = existing === null || existing.trim() === ''
        ? vary
        : `${ existing }, ${ vary }`;
    // Headers are immutable on some responses (a streamed one built with a literal init is
    // not), so the header is set on a clone-safe copy only when it must be.
    const headers = new Headers(response.headers);
    headers.set('vary', merged);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** @internal Attaches a freshly minted CSRF cookie without disturbing the response's own. */
function withMintedToken(response: Response, token: string, options: KitOptions): Response
{
    const name = options.csrf?.cookie ?? (options.csrf?.secure === false ? 'azcsrf' : '__Host-azcsrf');
    const cookie = serializeCookie(name, token, {
        secure: options.csrf?.secure !== false,
        httpOnly: false,
        sameSite: 'lax',
        path: '/'
    });
    const headers = new Headers();
    response.headers.forEach((value, key) =>
    {
        if (key !== 'set-cookie')
        {
            headers.set(key, value);
        }
    });
    for (const existing of response.headers.getSetCookie())
    {
        headers.append('set-cookie', existing);
    }
    headers.append('set-cookie', cookie);
    // 204/205/304 forbid a body, and the kernel materializes one even when empty.
    const body = response.status === 204 || response.status === 205 || response.status === 304
        ? null
        : response.body;
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * @internal Whether the client EXPLICITLY asked for JSON, which is what selects a page action's
 * enhanced representation. Asked positively, not as the absence of an HTML accept: a client
 * that sends no Accept at all is unknown, and the safe answer for a form endpoint is the one a
 * browser would get - the redirect a native submit needs, rather than a body it cannot follow.
 */
function acceptsJson(request: Request): boolean
{
    return (request.headers.get('accept') ?? '')
        .split(',')
        .some((entry) => entry.trim().toLowerCase().startsWith('application/json'));
}

/** @internal Whether the client asked for a document rather than an asset or a JSON API. */
function acceptsHtml(request: Request): boolean
{
    return (request.headers.get('accept') ?? '')
        .split(',')
        .some((entry) => entry.trim().toLowerCase().startsWith('text/html'));
}

/**
 * @internal The SSR-or-shell response for one request - shared by every dynamic path.
 * `shellStatus` answers the client-rendered case, where there is no server render to carry a
 * status and the shell itself is the whole answer.
 */
async function renderOrShell(
    context: RequestContext,
    mode: PageRoute['render'],
    options: KitOptions,
    shell: string,
    buildId: Promise<string>,
    shellStatus = 200,
    refusal?: { result: unknown; report: KitErrorObserver }
): Promise<Response>
{
    // Resolved before the render, so `<Form>` renders the same value the browser will hold.
    const csrf = tokenFor(context.request, options);
    const locale = localeFor(context.request, options, context.url.pathname);
    const url = appPath(context, options);
    const alternates = alternatesFor(context, options);
    if (mode === 'server' && options.renderer !== undefined)
    {
        // The nonce reaches the buffered path too, not just the streamed one: a server-rendered
        // page carries the scoped-CSS <style>, and without the nonce a strict `style-src`
        // refuses it and the page paints unstyled until hydration.
        const nonce = options.scriptNonce?.(context);
        const result = await options.renderer(
            url,
            shell,
            {
                signal: context.request.signal,
                // A rejected loader no longer throws out of the render - the page is served at
                // 500 with that level's own failure UI - so this is the ONLY place the fault
                // is reported. Without it a 500 arrives with no cause anywhere.
                onError: (error: unknown): void =>
                    observerFor(options)(error, { path: context.url.pathname, phase: 'render' }),
                ...(locale !== undefined ? { locale } : {}),
                ...(alternates.length > 0 ? { alternates } : {}),
                // A `server` page is uncached and uncoalesced: this render exists for THIS
                // request and nobody else can adopt it. So the client's disconnect signal is
                // the render's own lifetime, exactly as on the streamed path below - without
                // it, a client that opens connections and drops them still buys every loader's
                // full fan-out to the backing services, with no one left to read the answer.
                handoffMeta: { build: await buildId, at: Date.now() },
                ...(nonce !== undefined ? { scriptNonce: nonce } : {}),
                csrfToken: csrf.token,
                ...(refusal !== undefined ? { actionResult: refusal.result } : {}),
                ...(refusal !== undefined
                    ? { onError: (error: unknown): void => refusal.report(error, { path: context.url.pathname, phase: 'render' }) }
                    : {})
            });
        // A refused action re-renders at ITS status, not the render's: the page is fine, the
        // write was not, and 422 is what tells a client which of the two happened.
        const answered = refusal === undefined
            ? withVary(pageResponse(result, shell), context, options)
            : withVary(
                pageResponse(result.kind === 'html' ? { ...result, status: shellStatus } : result, shell),
                context, options);
        return csrf.minted ? withMintedToken(answered, csrf.token, options) : answered;
    }
    // The client-rendered page has no render to carry the language, and needs it just as much:
    // the shell IS the served document, and its `<html lang>` is what a crawler reads and what
    // lays the page out before a single byte of JavaScript has run.
    const bare = withVary(
        htmlResponse(
            locale === undefined ? shell : applyLocaleToShell(shell, locale, localeDirection(locale)),
            { status: shellStatus }),
        context, options);
    return csrf.minted ? withMintedToken(bare, csrf.token, options) : bare;
}

/** @internal An SSR-or-shell handler for one path; `'stream'` answers a streaming Response. */
function registerDynamic(
    app: App,
    path: string,
    mode: PageRoute['render'],
    options: KitOptions,
    shellPromise: Promise<string>,
    buildId: Promise<string>
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
                return renderOrShell(context, 'server', options, shell, buildId);
            }
            const nonce = options.scriptNonce?.(context);
            const result = await options.renderer(
                appPath(context, options),
                shell,
                {
                    stream: true,
                    signal: context.request.signal,
                    // A boundary that rejects AFTER the shell flushed cannot change the status,
                    // so without this the failure reaches nobody: the client gets a page missing
                    // a boundary and the server records a clean 200.
                    onError: (error: unknown): void => observerFor(options)(error, { path: context.url.pathname, phase: 'stream' }),
                    handoffMeta: { build: await buildId, at: Date.now() },
                    ...(nonce !== undefined ? { scriptNonce: nonce } : {}),
                    ...(localeFor(context.request, options, context.url.pathname) !== undefined
                        ? { locale: localeFor(context.request, options, context.url.pathname) as string }
                        : {}),
                    ...(alternatesFor(context, options).length > 0
                        ? { alternates: alternatesFor(context, options) }
                        : {})
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
                return withVary(new Response(result.stream, {
                    status: result.status,
                    headers: {
                        'content-type': 'text/html; charset=utf-8',
                        // A guarded stream is identity-dependent: no-cache alone permits
                        // STORAGE of the private bytes, only reuse needs revalidation.
                        'cache-control': result.guarded === true ? 'private, no-store' : 'no-cache',
                        'x-accel-buffering': 'no'
                    }
                }), context, options);
            }
            // A renderer unaware of the streaming option (or a redirect/veto, which stay
            // buffered by design) answered with an ordinary result: serve it as such.
            return withVary(pageResponse(result, shell), context, options);
        }
        return renderOrShell(context, mode, options, shell, buildId);
    });
}

/** @internal A prerendered-file-first handler for an enumerated static pattern. */
function registerStaticFirst(
    app: App,
    path: string,
    options: KitOptions,
    shellPromise: Promise<string>,
    assets: Handler,
    buildId: Promise<string>
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
            const tag = localeFor(context.request, options, context.url.pathname);
            if (tag !== undefined)
            {
                try
                {
                    return await assets({ ...context, params: { path: prerenderFileFor(context.path, tag) } });
                }
                catch (error)
                {
                    if (!(error instanceof NotFoundError))
                    {
                        throw error;
                    }
                }
            }
            return await assets({ ...context, params: { path: prerenderFileFor(context.path) } });
        }
        catch (error)
        {
            if (!(error instanceof NotFoundError))
            {
                throw error;
            }
        }
        return renderOrShell(context, dynamicMode, options, await shellPromise, buildId);
    });
}

export { FilePageCache, MemoryPageCache } from './isr.ts';
export type { KitErrorObserver, PageCache, PageEntry } from './isr.ts';
export { MemoryImageCache, imageHandler } from './image.ts';
export type { ImageAdapter, ImageCache, ImageCacheEntry, ImageHandlerOptions } from './image.ts';
export type { PageRenderOptions, PageRenderer, PageResult } from './ssr.ts';
