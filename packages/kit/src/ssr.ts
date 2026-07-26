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

/** One rendered page, or the redirect a guard/loader demanded. */
export type PageResult =
    | { kind: 'html'; html: string }
    | { kind: 'redirect'; to: string; replace: boolean };

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
        if (loaded !== null && 'redirect' in loaded)
        {
            const to = typeof loaded.redirect === 'string'
                ? loaded.redirect
                : loaded.redirect.pathname;
            return { kind: 'redirect', to, replace: loaded.replace };
        }

        const handoff = loaded ?? undefined;
        const body = renderToString(() => app(handoff !== undefined ? { url, handoff } : { url }));

        if (!shell.includes(ROOT_MARKER))
        {
            throw new Error(`kit: the built shell has no \`${ ROOT_MARKER }\` to render into - `
                + 'the client index.html must keep an empty root element.');
        }
        let html = shell.replace(ROOT_MARKER, `<div id="root">${ body }</div>`);
        const script = loaderHandoffScript(loaded);
        if (script !== '')
        {
            html = html.replace('</head>', `${ script }</head>`);
        }
        return { kind: 'html', html };
    };
}
