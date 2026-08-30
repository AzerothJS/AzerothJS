/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The page renderer (runs in the SSR bundle).
 *
 * `createPageRenderer(App, routes)` is the one line an application's SSR entry
 * needs. The returned function renders ONE url to a full HTML document, doing
 * everything the router's server side already knows how to do:
 *
 *   - `matchAndLoad` runs the chain's GUARDS (a redirecting guard surfaces as a real
 *     302, never a rendered page) and every level's loader IN PARALLEL;
 *   - the app renders through `renderToString` with the loader handoff passed in, so
 *     data is synchronously present during the render and the hydrating client
 *     adopts it without refetching;
 *   - the markup and the inert handoff script are spliced into the BUILT shell
 *     (vite's index.html), so the hashed script/css asset tags survive untouched.
 *
 * The App component contract is the same seam the canon template uses:
 * `App(props: { url?, handoff? })` - create the router with a memory history at
 * `props.url` and `initialLoaderData: props.handoff` when rendering server-side.
 */

import type { LoaderHandoff, MountNode, Route } from 'azerothjs';
import { collectStyleSheet, createRenderFrame, escapeAttr, loaderHandoffScript, matchAndLoad, renderToStream, renderToString } from 'azerothjs';
import type { RenderFrame } from 'azerothjs';
import type { CollectedHead } from 'azerothjs/internal';
import { collectHead, guardedMatch, targetToFullPath } from 'azerothjs/internal';

/** The app-component signature the renderer drives (the template's `App` shape). */
export type PageApp = (props: { url?: string; handoff?: LoaderHandoff }) => MountNode;

/**
 * One page-render outcome. The union may GROW, so a consumer switching on `kind` must
 * handle an unknown default rather than assume these are exhaustive.
 *
 *   - `html`     - rendered markup to serve with `status` (defaults to 200; a not-found
 *                  page renders the app's fallback UI at 404).
 *
 * The `html` and `stream` arms carry `guarded: true` when the matched chain has any route
 * guard. A guard makes the render a function of (URL, request identity), so a guarded
 * result must never enter a shared page cache, be written as a prerender file, or be
 * answered without `cache-control: private, no-store` - hosts that persist or share
 * rendered pages key those refusals on this stamp.
 *   - `redirect` - a guard/loader redirected; serve a 302.
 *   - `blocked`  - a guard VETOED; serve `status` (403) with NO rendered component. This is
 *                  the arm that stops the guard-veto authorization bypass.
 *   - `stream`   - a streaming render: the full document as bytes, shell first, Suspense
 *                  chunks as they settle. Produced only when the caller ASKED to stream;
 *                  redirects/vetoes/404-status detection stay buffered (they resolve before
 *                  any byte exists).
 */
export type PageResult =
    | { kind: 'html'; html: string; status: number; guarded?: boolean }
    | { kind: 'redirect'; to: string; replace: boolean }
    | { kind: 'blocked'; status: number }
    | { kind: 'refused-redirect'; target: string }
    | { kind: 'stream'; status: number; stream: ReadableStream<Uint8Array>; guarded?: boolean };

/** How one render is asked to behave; omitted entirely for the buffered default. */
export interface PageRenderOptions
{
    /** Ask for a `stream` result. A renderer unaware of this option answers buffered - callers handle both. */
    stream?: boolean;

    /** Aborts the render (client disconnect): server fetches abort, the stream ends. */
    signal?: AbortSignal;

    /**
     * Hears a STREAMED render's failure after the shell has already flushed.
     *
     * A Suspense boundary that rejects mid-stream cannot change the status - it left with the
     * head - so `renderToStream` reports it here and lets the stream continue. Without this
     * the failure is swallowed entirely: the client gets a page missing a boundary and the
     * server records a clean 200, which is the one shape no observability seam can see.
     * Ignored by the buffered path, where a failure still becomes a real status.
     */
    onError?: (error: unknown) => void;

    /**
     * CSP nonce stamped onto the inline scripts a streamed page emits. REQUIRED under any
     * `script-src` without `'unsafe-inline'`: without it the browser blocks the swap runtime,
     * every boundary stays on its fallback until hydration refetches the data, and the streamed
     * bytes are wasted - streaming becomes slower than buffering. Must be per-request.
     */
    scriptNonce?: string;

    /**
     * Deploy-identity and produce-time stamps for the loader handoff: `build` lets the
     * client drop cross-deploy seeds, `at` lets it heal a page served stale from a page
     * cache, `static` marks build-time data that must adopt fresh forever. The host that
     * knows these (mountPages, prerender) passes them; a bare renderer call emits none.
     */
    handoffMeta?: { build?: string; at?: number; static?: boolean };
}

/** The per-url renderer `createPageRenderer` returns and `mountPages`/`prerender` consume. */
export type PageRenderer = (url: string, shell: string, options?: PageRenderOptions) => Promise<PageResult>;

/** @internal The shell marker the rendered markup replaces. */
const ROOT_MARKER = '<div id="root"></div>';

/**
 * The base64/base64url alphabet a CSP nonce may use. The value arrives from a per-request
 * host callback over the live request, so anything outside this set is either an injection
 * attempt or a broken generator - both are refused loudly rather than escaped into the
 * attribute, where the policy would reject the token anyway.
 *
 * @internal
 */
const CSP_NONCE = /^[A-Za-z0-9+/=_-]+$/;

/** Escapes regex metacharacters in a literal attribute value. @internal */
function regexEscape(value: string): string
{
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The bounded shell-matching pattern for one keyed singleton: the tag, the identity
 * attribute with its exact double-quoted value (attribute-order tolerant within the one
 * tag), and media REQUIRED when the key carries it, REFUSED when it does not - media is
 * part of the identity, so a shell theme-color WITH media never matches a runtime one
 * without.
 *
 * @internal
 */
function shellElementPattern(item: CollectedHead['replacements'][number]): RegExp
{
    const requires = `(?=[^>]*\\b${ regexEscape(item.attr) }\\s*=\\s*"${ regexEscape(item.value) }")`;
    const media = item.media !== undefined
        ? `(?=[^>]*\\bmedia\\s*=\\s*"${ regexEscape(item.media) }")`
        : '(?![^>]*\\bmedia\\s*=)';
    return new RegExp(`<${ item.kind }\\b${ requires }${ media }[^>]*/?>`, 'i');
}

/**
 * Applies a drained head to the shell: content-only title surgery (shell attributes
 * preserved, the original text stamped for the client's restore), bounded replace-once
 * of keyed shell elements, and appended additions. Kit performs string POSITIONING only:
 * every element body comes runtime-serialized, the title text arrives runtime-escaped,
 * and the one escaping act on kit's side - the base-title stamp - runs SHELL-OWNED text
 * through the runtime's public escapeAttr. Function replacers throughout, so `$`-patterns
 * in content survive literally. Any pattern non-match degrades to APPEND; a shell without
 * `</head>` receives no head work at all (the anchor is the one hard requirement).
 *
 * `prelude` is the host's own head content - the scoped stylesheet, then the loader
 * handoff - emitted ahead of the head additions. Every insertion shares the ONE anchor
 * located here, on the shell BEFORE any content lands: inserted content may itself contain
 * a literal `</head>` (CSS legitimately can, inside a string), and re-searching after an
 * insert would land every later splice inside that content instead of the head.
 *
 * @internal Exported for the kit test suite.
 */
export function applyHeadToShell(shell: string, collected: CollectedHead, prelude = ''): string
{
    const headEnd = shell.indexOf('</head>');
    if (headEnd === -1)
    {
        return shell;
    }
    // Surgery is BOUNDED to the head slice, so a body element can never be matched.
    let head = shell.slice(0, headEnd);
    const rest = shell.slice(headEnd);
    const extras: string[] = [];

    if (collected.titleText !== null)
    {
        let replaced = false as boolean;
        head = head.replace(/(<title\b[^>]*)(>)([\s\S]*?)(<\/title>)/i,
            (_whole, open: string, gt: string, original: string, close: string) =>
            {
                replaced = true;
                const stamped = open.includes('data-azeroth-title-base')
                    ? open
                    : `${ open } data-azeroth-title-base="${ escapeAttr(original) }"`;
                return `${ stamped }${ gt }${ collected.titleText ?? '' }${ close }`;
            });
        if (!replaced && collected.titleElementHtml !== null)
        {
            extras.push(collected.titleElementHtml);
        }
    }

    for (const item of collected.replacements)
    {
        let replaced = false as boolean;
        head = head.replace(shellElementPattern(item), () =>
        {
            replaced = true;
            return item.html;
        });
        if (!replaced)
        {
            extras.push(item.html);
        }
    }

    const additions = prelude + extras.join('') + collected.additions;
    return additions === '' ? head + rest : `${ head }${ additions }${ rest }`;
}

/** One render's drained frames, ready to splice into the head. @internal */
interface DrainedFrames
{
    /** The scoped stylesheet as a `<style>` element, empty when nothing was registered. */
    styleTag: string;

    /** The head runtime's structured drain. */
    head: CollectedHead;
}

/**
 * Drains the frames the render just produced. `css()` and `useHead()` have no document to
 * write into on the server, so they record against the render and wait for the HOST to
 * publish them - which makes the drain, not the splice, the load-bearing act: a frame left
 * behind is published by whichever render collects NEXT, putting one request's stylesheet,
 * `<title>` and og:meta into an unrelated request's document. Every path out of a render
 * therefore reaches this, the throw path included, where the drained values die with the
 * error instead of being served.
 *
 * Style before head, and both AFTER the render: collecting before it would publish the frame
 * the previous render left behind and strand this render's own.
 *
 * @internal
 */
function drainFrames(scriptNonce: string | undefined, frame: RenderFrame): DrainedFrames
{
    // The frame THIS render wrote - handed to the render call and back to both drains,
    // so the kit is provably exact rather than drain-by-position correct: no interleaved
    // render can be served here, and none can receive this render's head or styles.
    const styles = collectStyleSheet(frame);
    const nonce = scriptNonce === undefined ? '' : ` nonce="${ escapeAttr(scriptNonce) }"`;
    return {
        styleTag: styles === '' ? '' : `<style data-azeroth-css${ nonce }>${ styles }</style>`,
        head: collectHead(scriptNonce !== undefined ? { scriptNonce, frame } : { frame })
    };
}

/**
 * Builds the per-url renderer for `mountPages` (server) and the prerender pass
 * (build). `shell` is the BUILT index.html text - asset tags preserved.
 */
export function createPageRenderer(app: PageApp, routes: Route[]): PageRenderer
{
    return async (url, shell, options) =>
    {
        if (options?.scriptNonce !== undefined && !CSP_NONCE.test(options.scriptNonce))
        {
            throw new Error('kit: scriptNonce is not a valid CSP nonce - base64/base64url characters only. '
                + 'Generate it per request from a CSPRNG; never derive it from request data.');
        }

        const loaded = await matchAndLoad(routes, url, options?.signal !== undefined ? { signal: options.signal } : undefined);

        // The same selection walk matchAndLoad just performed, asked one static question:
        // does the chain carry a guard? A guarded render is a function of (URL, request
        // identity), and the stamp is how every host that persists or shares pages -
        // the ISR cache, the prerender pass, a CDN via response headers - hears it.
        const guarded = guardedMatch(routes, url);

        // An OFF-ORIGIN guard/loader redirect is refused at the router boundary and arrives
        // here as its own terminal outcome. It is never rendered and never written to a
        // Location header: rendering would serve the page the guard declined, and writing it
        // is the open redirect itself.
        if (loaded !== null && 'refusedRedirect' in loaded)
        {
            return { kind: 'refused-redirect', target: loaded.target };
        }

        // A guard/loader redirect -> a real 302; never render the target.
        if (loaded !== null && 'redirect' in loaded)
        {
            // The object form carries query and hash the client honours; keeping only the
            // pathname silently dropped the comeback-query idiom the router documents
            // (a login redirect carrying where to return to) on the SSR leg alone.
            const to = typeof loaded.redirect === 'string'
                ? loaded.redirect
                : targetToFullPath(loaded.redirect);
            return { kind: 'redirect', to, replace: loaded.replace };
        }

        // A guard VETO -> serve the status, render NOTHING. Rendering here is the SSR
        // authorization bypass: string-mode rendering does not re-run guards (matchAndLoad
        // owns that server-side), so a rendered vetoed route would ship the protected
        // component in a 200 document.
        if (loaded !== null && 'blocked' in loaded)
        {
            return { kind: 'blocked', status: loaded.status };
        }

        // No route matched -> render the app's own fallback UI, but with a real 404 status.
        const notFound = loaded !== null && 'notFound' in loaded;
        const handoff = loaded !== null && 'version' in loaded ? loaded : undefined;

        // The handoff is ALWAYS emitted - a loader-less page carries an empty envelope so
        // the client still has the build/at baseline for deploy-aware adoption.
        const pageUrl = new URL(url, 'http://azeroth.local');
        const handoffMeta = { ...(options?.handoffMeta ?? {}), path: pageUrl.pathname + pageUrl.search };

        if (!shell.includes(ROOT_MARKER))
        {
            throw new Error(`kit: the built shell has no \`${ ROOT_MARKER }\` to render into - `
                + 'the client index.html must keep an empty root element.');
        }

        if (options?.stream === true)
        {
            // STREAMING: the loader handoff is fully known BEFORE any byte flushes (the
            // loaders ran above), so the script still rides the head; only Suspense
            // resource seeds arrive later, inside their chunks. The shell splits around
            // the root marker: head flushes immediately, tail follows the last chunk.
            const marker = shell.indexOf(ROOT_MARKER);
            let head = `${ shell.slice(0, marker) }<div id="root">`;
            const tail = `</div>${ shell.slice(marker + ROOT_MARKER.length) }`;
            // The main pass runs synchronously inside renderToStream: a top-level throw
            // rejects THIS promise and the caller answers a buffered 500 - zero torn bytes.
            // The drain rides a `finally` on that pass, so nothing can execute between the
            // render and it, and this render's frames are gone before the promise rejects.
            // Both frames are still spliced into the head - it has not been enqueued yet,
            // `start()` below does that - which is the declare-before-flush contract:
            // everything the synchronous pass declared is in hand before the first byte.
            // Without it a `render: 'stream'` page flushed its shell carrying scoped class
            // names and no rules - an unstyled first paint, which is precisely what streaming
            // exists to avoid.
            let body: ReadableStream<Uint8Array>;
            let frames: DrainedFrames;
            // Constructed BEFORE the render, so the finally holds it on the throw path.
            const frame = createRenderFrame();
            try
            {
                body = renderToStream(
                    () => app(handoff !== undefined ? { url, handoff } : { url }),
                    {
                        frame,
                        ...(options.signal !== undefined ? { signal: options.signal } : {}),
                        ...(options.onError !== undefined ? { onError: options.onError } : {}),
                        ...(options.scriptNonce !== undefined ? { scriptNonce: options.scriptNonce } : {})
                    });
            }
            finally
            {
                frames = drainFrames(options.scriptNonce, frame);
            }
            const script = loaderHandoffScript(loaded, handoffMeta);
            // Style and handoff ride in as the prelude, so the emitted order is
            // style -> handoff -> head additions in BOTH modes, all at one anchor located
            // before any of them is inserted.
            head = applyHeadToShell(head, frames.head, frames.styleTag + script);
            const encoder = new TextEncoder();
            const reader = body.getReader();
            const stream = new ReadableStream<Uint8Array>({
                start(controller): void
                {
                    controller.enqueue(encoder.encode(head));
                },
                async pull(controller): Promise<void>
                {
                    const { done, value } = await reader.read();
                    if (done)
                    {
                        controller.enqueue(encoder.encode(tail));
                        controller.close();
                        return;
                    }
                    controller.enqueue(value);
                },
                cancel(reason): Promise<void>
                {
                    return reader.cancel(reason);
                }
            });
            return { kind: 'stream', status: notFound ? 404 : 200, stream, ...(guarded ? { guarded: true } : {}) };
        }

        // The drain rides a `finally` on the render, so nothing can execute between the two
        // and this render's frames are gone before any later step can throw. Without the
        // drain the SSR'd document arrives unstyled and headless, and only gets its rules
        // once hydration runs - a flash of unstyled content on every server-rendered page.
        let body: string;
        let frames: DrainedFrames;
        // Constructed BEFORE the render, so the finally holds it on the throw path.
        const frame = createRenderFrame();
        try
        {
            body = renderToString(() => app(handoff !== undefined ? { url, handoff } : { url }), { frame });
        }
        finally
        {
            frames = drainFrames(options?.scriptNonce, frame);
        }
        // A function replacer, NOT the string form: rendered markup routinely contains
        // `$&`, `` $` ``, `$'`, `$$` (any text with a literal `$` before a quote or
        // ampersand), which the string form would interpret as replacement patterns and
        // splice the document's own head or tail into the output. The function form
        // treats the replacement verbatim.
        const rendered = `<div id="root">${ body }</div>`;
        let html = shell.replace(ROOT_MARKER, () => rendered);
        const script = loaderHandoffScript(loaded, handoffMeta);
        // Title surgery, keyed replacements, additions - order in the document:
        // style -> handoff -> head, all at one anchor located before any of them is inserted.
        html = applyHeadToShell(html, frames.head, frames.styleTag + script);
        return { kind: 'html', html, status: notFound ? 404 : 200, ...(guarded ? { guarded: true } : {}) };
    };
}
