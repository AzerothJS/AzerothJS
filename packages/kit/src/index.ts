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

import type { Route } from 'azerothjs';
import { guardedMatch, isRedirect, targetToFullPath } from 'azerothjs/internal';
import type { App, Handler, RequestContext } from '@azerothjs/http';
import { html as htmlResponse, json as jsonResponse, readForm, verifyCsrfField, csrfToken, serializeCookie, parseCookies, CSRF_FIELD, NotFoundError } from '@azerothjs/http';
import type { CsrfOptions } from '@azerothjs/http';
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

    for (const page of flattenPages(options.routes))
    {
        const mode = page.render ?? defaultMode;
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
            registerIsr({
                app,
                path: page.path,
                revalidate: page.revalidate,
                guarded: (url) => guardedMatch(options.routes, url),
                cache: isrCache,
                renderer: options.renderer,
                shell: shellPromise,
                seedFile,
                buildId: buildIdPromise,
                onError: report
            });
            continue;
        }
        if (page.path.includes(':') || page.path.includes('*'))
        {
            if (mode === 'static' && !page.path.includes('*'))
            {
                // An enumerated static page: try the prerendered file for the matched
                // params first, live-render anything the enumeration did not list.
                registerStaticFirst(app, page.path, options, shellPromise, assets, buildIdPromise);
            }
            else
            {
                // A wildcard cannot prerender one file: 'static' downgrades to
                // per-request SSR when a renderer exists, else to the shell.
                registerDynamic(app, page.path, mode === 'static' ? defaultMode : mode, options, shellPromise, buildIdPromise);
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
            registerDynamic(app, page.path, mode, options, shellPromise, buildIdPromise);
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

/**
 * @internal Runs one page action for a form submit.
 *
 * The order is load-bearing. The body is read FIRST because the CSRF token arrives in it - a
 * plain form cannot set a header - and the token is checked before the action runs, so a
 * cross-site submit never reaches application code. On success the answer is a 303 rather than
 * rendered markup: that is what stops a refresh from re-posting, and it makes the loader the
 * single source of what the page then shows.
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
    app.post(page.path, async (context) =>
    {
        const form = await readForm(context.request);
        verifyCsrfField(context.request, context.url, form.get(CSRF_FIELD), options.csrf ?? {});
        // The token is not the application's business, and leaving it in would put it in front
        // of every schema that validates the submitted fields.
        form.delete(CSRF_FIELD);

        let result: unknown;
        try
        {
            result = await action({ form, params: context.params, request: context.request, url: context.url });
        }
        catch (error)
        {
            if (isRedirect(error))
            {
                const target = error.to;
                return seeOther(typeof target === 'string' ? target : targetToFullPath(target));
            }
            throw error;
        }
        // One action, two representations, chosen by what the client asked for. A NATIVE form
        // submit is a navigation and needs the redirect-then-render dance; an enhanced submit is
        // a fetch that wants the value, and following a 303 to re-download the page it is
        // already showing would defeat the point of intercepting it.
        const wantsJson = acceptsJson(context.request);
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
    });
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
    if (mode === 'server' && options.renderer !== undefined)
    {
        // The nonce reaches the buffered path too, not just the streamed one: a server-rendered
        // page carries the scoped-CSS <style>, and without the nonce a strict `style-src`
        // refuses it and the page paints unstyled until hydration.
        const nonce = options.scriptNonce?.(context);
        const result = await options.renderer(
            context.url.pathname + context.url.search,
            shell,
            {
                signal: context.request.signal,
                // A rejected loader no longer throws out of the render - the page is served at
                // 500 with that level's own failure UI - so this is the ONLY place the fault
                // is reported. Without it a 500 arrives with no cause anywhere.
                onError: (error: unknown): void =>
                    observerFor(options)(error, { path: context.url.pathname, phase: 'render' }),
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
            ? pageResponse(result, shell)
            : pageResponse(result.kind === 'html' ? { ...result, status: shellStatus } : result, shell);
        return csrf.minted ? withMintedToken(answered, csrf.token, options) : answered;
    }
    const bare = htmlResponse(shell, { status: shellStatus });
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
                context.url.pathname + context.url.search,
                shell,
                {
                    stream: true,
                    signal: context.request.signal,
                    // A boundary that rejects AFTER the shell flushed cannot change the status,
                    // so without this the failure reaches nobody: the client gets a page missing
                    // a boundary and the server records a clean 200.
                    onError: (error: unknown): void => observerFor(options)(error, { path: context.url.pathname, phase: 'stream' }),
                    handoffMeta: { build: await buildId, at: Date.now() },
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
                        // A guarded stream is identity-dependent: no-cache alone permits
                        // STORAGE of the private bytes, only reuse needs revalidation.
                        'cache-control': result.guarded === true ? 'private, no-store' : 'no-cache',
                        'x-accel-buffering': 'no'
                    }
                });
            }
            // A renderer unaware of the streaming option (or a redirect/veto, which stay
            // buffered by design) answered with an ordinary result: serve it as such.
            return pageResponse(result, shell);
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
