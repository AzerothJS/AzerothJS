/**
 * MODULE: kit/ssr - the page renderer (runs in the SSR bundle)
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
import { collectStyleSheet, loaderHandoffScript, matchAndLoad, renderToStream, renderToString } from 'azerothjs';

/** The app-component signature the renderer drives (the template's `App` shape). */
export type PageApp = (props: { url?: string; handoff?: LoaderHandoff }) => MountNode;

/**
 * One page-render outcome. The union may GROW, so a consumer switching on `kind` must
 * handle an unknown default rather than assume these are exhaustive.
 *
 *   - `html`     - rendered markup to serve with `status` (defaults to 200; a not-found
 *                  page renders the app's fallback UI at 404).
 *   - `redirect` - a guard/loader redirected; serve a 302.
 *   - `blocked`  - a guard VETOED; serve `status` (403) with NO rendered component. This is
 *                  the arm that stops the guard-veto authorization bypass.
 *   - `stream`   - a streaming render: the full document as bytes, shell first, Suspense
 *                  chunks as they settle. Produced only when the caller ASKED to stream;
 *                  redirects/vetoes/404-status detection stay buffered (they resolve before
 *                  any byte exists).
 */
export type PageResult =
    | { kind: 'html'; html: string; status: number }
    | { kind: 'redirect'; to: string; replace: boolean }
    | { kind: 'blocked'; status: number }
    | { kind: 'stream'; status: number; stream: ReadableStream<Uint8Array> };

/** How one render is asked to behave; omitted entirely for the buffered default. */
export interface PageRenderOptions
{
    /** Ask for a `stream` result. A renderer unaware of this option answers buffered - callers handle both. */
    stream?: boolean;

    /** Aborts the render (client disconnect): server fetches abort, the stream ends. */
    signal?: AbortSignal;

    /**
     * CSP nonce stamped onto the inline scripts a streamed page emits. REQUIRED under any
     * `script-src` without `'unsafe-inline'`: without it the browser blocks the swap runtime,
     * every boundary stays on its fallback until hydration refetches the data, and the streamed
     * bytes are wasted - streaming becomes slower than buffering. Must be per-request.
     */
    scriptNonce?: string;
}

/** The per-url renderer `createPageRenderer` returns and `mountPages`/`prerender` consume. */
export type PageRenderer = (url: string, shell: string, options?: PageRenderOptions) => Promise<PageResult>;

/** @internal The shell marker the rendered markup replaces. */
const ROOT_MARKER = '<div id="root"></div>';

/**
 * Builds the per-url renderer for `mountPages` (server) and the prerender pass
 * (build). `shell` is the BUILT index.html text - asset tags preserved.
 */
export function createPageRenderer(app: PageApp, routes: Route[]): PageRenderer
{
    return async (url, shell, options) =>
    {
        const loaded = await matchAndLoad(routes, url, options?.signal !== undefined ? { signal: options.signal } : undefined);

        // A guard/loader redirect -> a real 302; never render the target.
        if (loaded !== null && 'redirect' in loaded)
        {
            const to = typeof loaded.redirect === 'string'
                ? loaded.redirect
                : loaded.redirect.pathname;
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
            const script = handoff !== undefined ? loaderHandoffScript(loaded) : '';
            if (script !== '')
            {
                head = head.replace('</head>', () => `${ script }</head>`);
            }
            const tail = `</div>${ shell.slice(marker + ROOT_MARKER.length) }`;
            // The main pass runs synchronously inside renderToStream: a top-level throw
            // rejects THIS promise and the caller answers a buffered 500 - zero torn bytes.
            const body = renderToStream(
                () => app(handoff !== undefined ? { url, handoff } : { url }),
                {
                    ...(options.signal !== undefined ? { signal: options.signal } : {}),
                    ...(options.scriptNonce !== undefined ? { scriptNonce: options.scriptNonce } : {})
                });
            // Scoped CSS, collected AFTER that synchronous main pass and still spliced into the
            // head - the head has not been enqueued yet, `start()` below does that. The ordering
            // is what makes this correct: collecting BEFORE the render would publish whatever
            // frame the PREVIOUS render left behind (measured: one tenant's interpolated colour
            // in another tenant's page) and leave this render's own frame undrained for the next
            // request to publish. Collecting after means each render drains exactly its own.
            //
            // Without this a `render: 'stream'` page flushed its shell carrying scoped class
            // names and no rules - an unstyled first paint, which is precisely what streaming
            // exists to avoid.
            const streamedStyles = collectStyleSheet();
            if (streamedStyles !== '')
            {
                const nonce = options.scriptNonce === undefined ? '' : ` nonce="${ options.scriptNonce }"`;
                head = head.replace('</head>', () => `<style data-azeroth-css${ nonce }>${ streamedStyles }</style></head>`);
            }
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
            return { kind: 'stream', status: notFound ? 404 : 200, stream };
        }

        const body = renderToString(() => app(handoff !== undefined ? { url, handoff } : { url }));
        // Function replacers, NOT the string form: rendered markup and the JSON
        // handoff routinely contain `$&`, `` $` ``, `$'`, `$$` (any text with a
        // literal `$` before a quote or ampersand), which the string form would
        // interpret as replacement patterns and splice the document's own head or
        // tail into the output. The function form treats the replacement verbatim.
        const rendered = `<div id="root">${ body }</div>`;
        let html = shell.replace(ROOT_MARKER, () => rendered);
        // Scoped CSS registered by this render. `css()` has no <head> to inject into on the
        // server, so it records against the render and expects the host to drain it here -
        // without this the SSR'd document arrives unstyled and only gets its rules once
        // hydration runs, which is a flash of unstyled content on every server-rendered page.
        const styles = collectStyleSheet();
        if (styles !== '')
        {
            const nonce = options?.scriptNonce === undefined ? '' : ` nonce="${ options.scriptNonce }"`;
            html = html.replace('</head>', () => `<style data-azeroth-css${ nonce }>${ styles }</style></head>`);
        }
        const script = handoff !== undefined ? loaderHandoffScript(loaded) : '';
        if (script !== '')
        {
            html = html.replace('</head>', () => `${ script }</head>`);
        }
        return { kind: 'html', html, status: notFound ? 404 : 200 };
    };
}
