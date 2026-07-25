/**
 * MODULE: router/handoff - the SSR loader handoff, both directions
 *
 * When the server renders a route it also runs that route's loader; the result must reach
 * the hydrating client so it does not refetch what the server just loaded. This module owns
 * that handoff end to end - one file defines the wire format, so the two sides cannot drift:
 *
 *   - `matchAndLoad(routes, url)` - SERVER: match the URL against the same route table the
 *     client uses and run the matched leaf's loader; returns `{ path, data }` or null.
 *   - `loaderHandoffScript(handoff)` - SERVER: the payload as an inert JSON script tag for
 *     the document head. `type="application/json"` means the browser never EXECUTES it -
 *     the classic `window.__DATA__ = {...}` inline script is an XSS foothold the moment a
 *     string in the payload contains `</script>`; here the only escaping needed is `<`
 *     (to <), and a malicious payload string stays a string.
 *   - `readLoaderHandoff()` - CLIENT: parse that tag back, for
 *     `createRouter({ ..., initialLoaderData: readLoaderHandoff() })`.
 *
 * The handoff is keyed by the EXACT base-relative pathname + search the server rendered;
 * the router adopts it only when its initial location matches, so a stale or misrouted
 * payload degrades to a normal fetch, never to wrong data.
 */

import type { LoaderHandoff, Route } from './types.ts';
import { flattenRoutes, splitFullPath } from './router.ts';

/** The DOM id of the handoff script tag. */
export const LOADER_HANDOFF_ID = '__azeroth-loader-handoff';

/**
 * SERVER: matches `url` against `routes` and runs the matched leaf's loader - the same
 * matching the client router performs, reused so the two sides cannot disagree about which
 * loader owns a URL. Returns null when nothing matches or the matched route has no loader.
 * The AbortSignal (pass the request's) cancels the loader when the client disconnects.
 */
export async function matchAndLoad(
    routes: Route[],
    url: string | URL,
    options: { signal?: AbortSignal } = {}
): Promise<LoaderHandoff | null>
{
    const full = typeof url === 'string' ? url : url.pathname + url.search;
    const { pathname, search } = splitFullPath(full);

    for (const entry of flattenRoutes(routes))
    {
        const result = entry.matcher.match(pathname);
        if (result === null)
        {
            continue;
        }
        const leaf = entry.matched[entry.matched.length - 1];
        if (leaf === undefined || !leaf.loader)
        {
            return null; // matched, but this route loads nothing - nothing to hand off
        }
        const data = await leaf.loader({
            params: result.params,
            signal: options.signal ?? new AbortController().signal
        });
        return { path: pathname + search, data };
    }
    return null;
}

/**
 * SERVER: the handoff as an inert JSON script tag for renderToDocument's `head`. Returns ''
 * for null, so `head: loaderHandoffScript(await matchAndLoad(...))` needs no branching.
 */
export function loaderHandoffScript(handoff: LoaderHandoff | null): string
{
    if (handoff === null)
    {
        return '';
    }
    // <-escaping closes the only injection route out of a JSON script tag: a payload
    // string containing `</script>` (or `<!--`) cannot terminate the tag once no literal
    // `<` survives. JSON itself never NEEDS a literal `<`, so the escape is lossless.
    const json = JSON.stringify(handoff).replace(/</g, '\\u003c');
    return `<script type="application/json" id="${ LOADER_HANDOFF_ID }">${ json }</script>`;
}

/**
 * CLIENT: reads the handoff the server embedded, or undefined when there is none (a plain
 * client-side start). Malformed content degrades to undefined - the router then just
 * fetches, which is always a correct fallback.
 */
export function readLoaderHandoff(): LoaderHandoff | undefined
{
    const doc = (globalThis as { document?: Document }).document;
    const text = doc?.getElementById(LOADER_HANDOFF_ID)?.textContent;
    if (typeof text !== 'string')
    {
        return undefined;
    }
    try
    {
        return JSON.parse(text) as LoaderHandoff;
    }
    catch
    {
        return undefined;
    }
}
