/**
 * MODULE: router/handoff - the SSR loader handoff, both directions
 *
 * When the server renders a route it also runs the matched chain's loaders; the results
 * must reach the hydrating client so it does not refetch what the server just loaded.
 * This module owns that handoff end to end - one file defines the wire format, so the
 * two sides cannot drift:
 *
 *   - `matchAndLoad(routes, url)` - SERVER: match the URL against the same route table
 *     the client uses, pre-resolve any lazy chunks in the chain (the subsequent render
 *     is synchronous), and run EVERY matched level's loader in parallel; returns
 *     `{ version, path, data }` (data BY LEVEL, root to leaf) or null.
 *   - `loaderHandoffScript(handoff)` - SERVER: the payload as an inert JSON script tag
 *     for the document head. `type="application/json"` means the browser never EXECUTES
 *     it - the classic `window.__DATA__ = {...}` inline script is an XSS foothold the
 *     moment a string in the payload contains `</script>`; here the only escaping
 *     needed is `<` (to <), and a malicious payload string stays a string.
 *   - `readLoaderHandoff()` - CLIENT: parse that tag back, for
 *     `createRouter({ ..., initialLoaderData: readLoaderHandoff() })`.
 *
 * The handoff is keyed by the EXACT base-relative pathname + search the server rendered
 * AND by {@link LOADER_HANDOFF_VERSION}: the router adopts it only when both match, so a
 * stale payload, a misrouted URL, or an older server's wire shape all degrade to a
 * normal fetch - never to wrong data.
 */

import type { LoaderHandoff, Route } from './types.ts';
import { flattenRoutes, splitFullPath, resolveRouteComponent } from './router.ts';
import { parseQuery } from './query.ts';

/** The DOM id of the handoff script tag. */
export const LOADER_HANDOFF_ID = '__azeroth-loader-handoff';

/** The handoff wire-format version; bumped when the payload shape changes. */
export const LOADER_HANDOFF_VERSION = 2;

/**
 * SERVER: matches `url` against `routes` and runs EVERY matched level's loader in
 * parallel - the same matching and the same parallelism the client router performs,
 * reused so the two sides cannot disagree. Lazy chunks in the chain are resolved here
 * too, so the synchronous SSR render that follows finds every component ready. Returns
 * null when nothing matches or no level declares a loader. The AbortSignal (pass the
 * request's) cancels the loaders when the client disconnects.
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

        await Promise.all(entry.matched
            .filter((route) => route.lazy !== undefined)
            .map((route) => resolveRouteComponent(route)));

        if (!entry.matched.some((route) => route.loader))
        {
            return null; // matched, but no level loads - nothing to hand off
        }

        const signal = options.signal ?? new AbortController().signal;
        const query = parseQuery(search);

        // All levels start together; `parent` resolves to the nearest ancestor
        // loader's promise - the same slot discipline the client router applies.
        const slots: Array<Promise<unknown> | undefined> = [];
        const data = await Promise.all(entry.matched.map((route, level) =>
        {
            if (!route.loader)
            {
                return Promise.resolve(undefined);
            }
            let parent: Promise<unknown> = Promise.resolve(undefined);
            for (let above = level - 1; above >= 0; above--)
            {
                const slot = slots[above];
                if (slot !== undefined)
                {
                    parent = slot;
                    break;
                }
            }
            const promise = route.loader({ params: result.params, query, signal, parent });
            slots[level] = promise;
            return promise;
        }));

        return { version: LOADER_HANDOFF_VERSION, path: pathname + search, data };
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
 * CLIENT: reads the handoff the server embedded, or undefined when there is none (a
 * plain client-side start) or the wire shape is not this build's version (an old
 * server; adopting its shape would mis-seed levels). Malformed content degrades to
 * undefined - the router then just fetches, which is always a correct fallback.
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
        const parsed = JSON.parse(text) as LoaderHandoff;
        if (parsed.version !== LOADER_HANDOFF_VERSION || !Array.isArray(parsed.data))
        {
            return undefined;
        }
        return parsed;
    }
    catch
    {
        return undefined;
    }
}
