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

import type { LoaderHandoff, NavigateTarget, Route } from './types.ts';
import { flattenRoutes, splitFullPath, resolveRouteComponent } from './router.ts';
import { isRedirect } from './redirect.ts';
import { parseQuery } from './query.ts';

/** The DOM id of the handoff script tag. */
export const LOADER_HANDOFF_ID = '__azeroth-loader-handoff';

/** The handoff wire-format version; bumped when the payload shape changes. */
export const LOADER_HANDOFF_VERSION = 2;

/**
 * What {@link matchAndLoad} produces - EVERY server-side routing outcome, kept distinct so a
 * renderer never confuses "authorized, nothing to load" with "a guard said no":
 *
 *   - `LoaderHandoff`                    - matched, loaders ran; render and embed the data.
 *   - `{ redirect, replace }`            - a guard or loader redirected; answer with a 302.
 *   - `{ blocked: true, status }`        - a guard VETOED (returned false); the route MUST NOT
 *                                          render. Answer with `status` (403), never a 200 page
 *                                          - collapsing this into `null` is the SSR auth bypass.
 *   - `{ notFound: true }`               - no route matched; render the app's fallback UI, but
 *                                          with a real 404 (not a soft-404 at 200).
 *   - `null`                             - matched and authorized, but no level has a loader;
 *                                          render normally with no handoff.
 */
export type MatchAndLoadResult =
    | LoaderHandoff
    | { redirect: NavigateTarget; replace: boolean }
    | { blocked: true; status: number }
    | { notFound: true }
    | null;

/**
 * SERVER: matches `url` against `routes`, runs the chain's GUARDS root-to-leaf, and
 * runs every matched level's loader in parallel - the same matching, guarding, and
 * parallelism the client router performs, reused so the two sides cannot disagree.
 * Lazy chunks in the chain are resolved here too, so the synchronous SSR render that
 * follows finds every component ready.
 *
 * A guard or loader redirect surfaces as `{ redirect, replace }` - answer with a real
 * 302. A guard VETO returns null (like no match: the caller renders its fallback).
 * The AbortSignal (pass the request's) cancels the loaders when the client disconnects.
 */
export async function matchAndLoad(
    routes: Route[],
    url: string | URL,
    options: { signal?: AbortSignal } = {}
): Promise<MatchAndLoadResult>
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

        const query = parseQuery(search);

        // Guards first, root-to-leaf - a redirect becomes the server's 302; a veto is a
        // DISTINCT blocked result (a 403), never a rendered page. `from` is null: a server
        // render has no previous location.
        for (const route of entry.matched)
        {
            if (route.guard === undefined)
            {
                continue;
            }
            let verdict: unknown;
            try
            {
                verdict = await route.guard({ params: result.params, pathname, query, from: null });
            }
            catch (error)
            {
                if (isRedirect(error))
                {
                    return { redirect: error.to, replace: error.replace };
                }
                throw error;
            }
            if (verdict === false)
            {
                return { blocked: true, status: 403 };
            }
            if (verdict !== true && verdict !== undefined && verdict !== null)
            {
                return isRedirect(verdict)
                    ? { redirect: verdict.to, replace: verdict.replace }
                    : { redirect: verdict as NavigateTarget, replace: true };
            }
        }

        await Promise.all(entry.matched
            .filter((route) => route.lazy !== undefined)
            .map((route) => resolveRouteComponent(route)));

        if (!entry.matched.some((route) => route.loader))
        {
            return null; // matched, but no level loads - nothing to hand off
        }

        const signal = options.signal ?? new AbortController().signal;

        // All levels start together; `parent` resolves to the nearest ancestor
        // loader's promise - the same slot discipline the client router applies.
        const slots: Array<Promise<unknown> | undefined> = [];
        let data: unknown[];
        try
        {
            data = await Promise.all(entry.matched.map((route, level) =>
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
        }
        catch (error)
        {
            if (isRedirect(error))
            {
                return { redirect: error.to, replace: error.replace };
            }
            throw error;
        }

        return { version: LOADER_HANDOFF_VERSION, path: pathname + search, data };
    }
    // No route in the table matched this URL.
    return { notFound: true };
}

/**
 * SERVER: the handoff as an inert JSON script tag for renderToDocument's `head`. Returns ''
 * for null AND for the redirect shape (a redirecting response has no body to hydrate), so
 * `head: loaderHandoffScript(await matchAndLoad(...))` needs no branching.
 */
export function loaderHandoffScript(handoff: MatchAndLoadResult): string
{
    if (handoff === null || !('version' in handoff))
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
