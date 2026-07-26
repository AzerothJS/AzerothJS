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
import { loaderHandoffScript, matchAndLoad, renderToString } from 'azerothjs';

/** The app-component signature the renderer drives (the template's `App` shape). */
export type PageApp = (props: { url?: string; handoff?: LoaderHandoff }) => MountNode;

/**
 * One page-render outcome. The union may GROW (a streaming arm is planned), so a
 * consumer switching on `kind` must handle an unknown default rather than assume these
 * are exhaustive.
 *
 *   - `html`     - rendered markup to serve with `status` (defaults to 200; a not-found
 *                  page renders the app's fallback UI at 404).
 *   - `redirect` - a guard/loader redirected; serve a 302.
 *   - `blocked`  - a guard VETOED; serve `status` (403) with NO rendered component. This is
 *                  the arm that stops the guard-veto authorization bypass.
 */
export type PageResult =
    | { kind: 'html'; html: string; status: number }
    | { kind: 'redirect'; to: string; replace: boolean }
    | { kind: 'blocked'; status: number };

/** The per-url renderer `createPageRenderer` returns and `mountPages`/`prerender` consume. */
export type PageRenderer = (url: string, shell: string) => Promise<PageResult>;

/** @internal The shell marker the rendered markup replaces. */
const ROOT_MARKER = '<div id="root"></div>';

/**
 * Builds the per-url renderer for `mountPages` (server) and the prerender pass
 * (build). `shell` is the BUILT index.html text - asset tags preserved.
 */
export function createPageRenderer(app: PageApp, routes: Route[]): PageRenderer
{
    return async (url, shell) =>
    {
        const loaded = await matchAndLoad(routes, url);

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
        const body = renderToString(() => app(handoff !== undefined ? { url, handoff } : { url }));

        if (!shell.includes(ROOT_MARKER))
        {
            throw new Error(`kit: the built shell has no \`${ ROOT_MARKER }\` to render into - `
                + 'the client index.html must keep an empty root element.');
        }
        // Function replacers, NOT the string form: rendered markup and the JSON
        // handoff routinely contain `$&`, `` $` ``, `$'`, `$$` (any text with a
        // literal `$` before a quote or ampersand), which the string form would
        // interpret as replacement patterns and splice the document's own head or
        // tail into the output. The function form treats the replacement verbatim.
        const rendered = `<div id="root">${ body }</div>`;
        let html = shell.replace(ROOT_MARKER, () => rendered);
        const script = handoff !== undefined ? loaderHandoffScript(loaded) : '';
        if (script !== '')
        {
            html = html.replace('</head>', () => `${ script }</head>`);
        }
        return { kind: 'html', html, status: notFound ? 404 : 200 };
    };
}
