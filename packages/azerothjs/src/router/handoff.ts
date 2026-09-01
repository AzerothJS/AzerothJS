/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The SSR loader handoff, both directions.
 *
 * When the server renders a route it also runs the matched chain's loaders, and those
 * results must reach the hydrating client so it does not refetch what the server just
 * loaded. One file defines the wire format for both sides, so they cannot drift:
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

import { acceptRedirectTarget } from './redirect-target.ts';
import type { LoaderHandoff, NavigateTarget, Params, Route } from './types.ts';
import { flattenRoutesFor, splitFullPath, resolveRouteComponent, type LeafEntry } from './router.ts';
import { isRedirect } from './redirect.ts';
import { isNotFound } from './not-found.ts';
import { deniedStatus, isDenied } from './denied.ts';
import { LOADER_HANDOFF_ID, LOADER_HANDOFF_VERSION } from './handoff-wire.ts';
import { declaredQuery, parseQuery } from './query.ts';
import { prefixParams } from './loader-inputs.ts';
import { inertJson } from '../reactivity/ssr.ts';
import { latchServerData } from '../reactivity/data-cache.ts';

/**
 * What {@link matchAndLoad} produces - EVERY server-side routing outcome, kept distinct so a
 * renderer never confuses "authorized, nothing to load" with "a guard said no":
 *
 *   - `LoaderHandoff`                    - matched, loaders ran; render and embed the data.
 *   - `{ redirect, replace }`            - a guard or loader redirected; answer with a 302.
 *   - `{ blocked: true, status }`        - a guard VETOED (`false`, `unauthorized()` or
 *                                          `forbidden()`); the route MUST NOT render. Answer
 *                                          with `status` (401 or 403), never a 200 page -
 *                                          collapsing this into `null` is the SSR auth bypass.
 *   - `{ refusedRedirect, target }`     - a guard or loader redirected OFF-ORIGIN. An automatic
 *                                          navigation to an app-derived target that leaves the
 *                                          origin is the open-redirect shape, so it is refused
 *                                          here rather than written to a Location header. It is
 *                                          a distinct terminal outcome, NOT a drop: dropping it
 *                                          would render the page the guard declined to serve.
 *   - `{ notFound: true }`               - no route matched; render the app's fallback UI, but
 *                                          with a real 404 (not a soft-404 at 200).
 *   - `null`                             - matched and authorized, but no level has a loader;
 *                                          render normally with no handoff.
 */
/**
 * @internal One redirect outcome, judged at the boundary: an off-origin target becomes the
 * distinct refusal rather than a Location header. Refusing is NOT dropping - dropping would
 * render the page the guard declined to serve, which is the SSR authorization bypass the
 * blocked shape exists to prevent.
 */
function redirectOutcome(to: NavigateTarget, replace: boolean): MatchAndLoadResult
{
    const verdict = acceptRedirectTarget(to);
    return verdict.accepted
        ? { redirect: verdict.to, replace }
        : { refusedRedirect: true, target: verdict.target };
}

export type MatchAndLoadResult =
    | LoaderHandoff
    | { redirect: NavigateTarget; replace: boolean }
    | { blocked: true; status: 401 | 403 }
    | { refusedRedirect: true; target: string }
    | { notFound: true }
    | null;

/** @internal One selected chain: the URL's split plus the first entry whose matcher matched it. */
interface SelectedChain
{
    entry: LeafEntry;
    params: Params;
    pathname: string;
    search: string;
}

/**
 * The one entry-selection walk behind {@link matchAndLoad} and {@link guardedMatch}. Pure:
 * it owns the URL normalization and the order-first walk over the flattened table, and it
 * latches nothing, so a build- or mount-time caller cannot flip server-data mode. Both
 * consumers MUST select through here - two independent walks could drift on ordering or
 * normalization, and a guarded verdict is only meaningful about the chain that will run.
 *
 * @internal
 */
function selectChain(routes: Route[], url: string | URL): SelectedChain | null
{
    const full = typeof url === 'string' ? url : url.pathname + url.search;
    const { pathname, search } = splitFullPath(full);
    // Memoized: this walk is EVERY server-side selection - a warm ISR hit, an SSR render, a
    // cold miss - and it is the only front door both guardedMatch and matchAndLoad use.
    for (const entry of flattenRoutesFor(routes))
    {
        const result = entry.matcher.match(pathname);
        if (result !== null)
        {
            return { entry, params: result.params, pathname, search };
        }
    }
    return null;
}

/**
 * SERVER: whether `url`'s matched chain carries any guard - the static fact a page-cache
 * host needs before it may treat a rendered page as shared content. A guard makes the
 * render a function of (URL, request identity), so its output must never be cached,
 * seeded, or coalesced across visitors. Selection is the same walk {@link matchAndLoad}
 * performs, so the verdict describes the chain that will actually run. False for an
 * unmatched URL.
 */
export function guardedMatch(routes: Route[], url: string | URL): boolean
{
    const selected = selectChain(routes, url);
    return selected !== null && selected.entry.matched.some((route) => route.guard !== undefined);
}

/**
 * SERVER: matches `url` against `routes`, runs the chain's GUARDS root-to-leaf, and
 * runs every matched level's loader in parallel - the same matching, guarding, and
 * parallelism the client router performs, reused so the two sides cannot disagree.
 * Lazy chunks in the chain are resolved here too, so the synchronous SSR render that
 * follows finds every component ready.
 *
 * A guard or loader redirect surfaces as `{ redirect, replace }` - answer with a real
 * 302. A guard VETO surfaces as `{ blocked, status }` - answer with that status and render the
 * app's blocked UI, never the route. The AbortSignal (pass the request's) cancels the loaders
 * when the client disconnects.
 */
export async function matchAndLoad(
    routes: Route[],
    url: string | URL,
    options: { signal?: AbortSignal } = {}
): Promise<MatchAndLoadResult>
{
    // A server entry point: from here on, default-scope reads bypass the data cache so a
    // resolver-less host's loader-phase reads can never be shared across requests.
    latchServerData();
    const selected = selectChain(routes, url);
    if (selected === null)
    {
        // No route in the table matched this URL.
        return { notFound: true };
    }
    {
        const { entry, params, pathname, search } = selected;
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
                verdict = await route.guard({ params, pathname, query, from: null });
            }
            catch (error)
            {
                if (isRedirect(error))
                {
                    return redirectOutcome(error.to, error.replace);
                }
                if (isDenied(error))
                {
                    return { blocked: true, status: deniedStatus(error) };
                }
                throw error;
            }
            if (isDenied(verdict))
            {
                return { blocked: true, status: deniedStatus(verdict) };
            }
            if (verdict === false)
            {
                return { blocked: true, status: 403 };
            }
            if (verdict !== true && verdict !== undefined && verdict !== null)
            {
                return isRedirect(verdict)
                    ? redirectOutcome(verdict.to, verdict.replace)
                    : redirectOutcome(verdict as NavigateTarget, true);
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
                // The level's own inputs, per route - the same rule the client applies, and
                // for the reason the client applies it: this level's value is cached under a
                // key built from the prefix params and the declared query, and a navigation
                // that leaves that key unchanged starts NO fetch. Handing the loader wider
                // inputs here produced a value whose preimage was larger than its key, which
                // was then served for every other URL sharing that key - and because the
                // SEED is what the client adopts, narrowing only the client would have fixed
                // nothing on the path that actually renders. Guards keep the whole chain and
                // the raw query: they key nothing, so narrowing them would only remove
                // information an authorization decision may legitimately use.
                const promise = route.loader({
                    params: prefixParams(entry.matched, level, params),
                    query: declaredQuery(route.search, query),
                    signal,
                    parent
                });
                slots[level] = promise;
                return promise;
            }));
        }
        catch (error)
        {
            if (isRedirect(error))
            {
                return redirectOutcome(error.to, error.replace);
            }
            if (isNotFound(error))
            {
                return { notFound: true };
            }
            throw error;
        }

        return { version: LOADER_HANDOFF_VERSION, path: pathname + search, data };
    }
}

/** The deploy-identity and produce-time stamps a host adds to an emitted handoff. */
export interface HandoffMeta
{
    /** The producing deployment's build id. */
    build?: string;

    /** Produce time (epoch ms); omitted for build-static pages. */
    at?: number;

    /** Marks a build-time prerendered page without a revalidation window. */
    static?: boolean;

    /**
     * The page's pathname + search. With it, a page with NO loaders still emits an empty
     * handoff so the client always has a build/at baseline; without it, such pages emit
     * nothing, as before.
     */
    path?: string;
}

/**
 * SERVER: the handoff as an inert JSON script tag for renderToDocument's `head`. Returns ''
 * for the redirect/blocked/not-found shapes (no page body to hydrate), so
 * `head: loaderHandoffScript(await matchAndLoad(...))` needs no branching. `meta` stamps the
 * deploy identity and produce time, and its `path` makes loader-less pages emit an EMPTY
 * handoff instead of none - the client's baseline for deploy-aware adoption.
 */
export function loaderHandoffScript(handoff: MatchAndLoadResult, meta: HandoffMeta = {}): string
{
    let payload: LoaderHandoff | null = null;
    if (handoff !== null && 'version' in handoff)
    {
        payload = handoff;
    }
    else if ((handoff === null || 'notFound' in handoff) && meta.path !== undefined)
    {
        payload = { version: LOADER_HANDOFF_VERSION, path: meta.path, data: [] };
    }
    else if (handoff !== null && 'blocked' in handoff && meta.path !== undefined)
    {
        // The verdict, not data: a hydrating client has to settle into the blocked state on its
        // FIRST pass, before its own guards run, or it adopts the not-found UI over blocked
        // markup and tears the whole page down.
        payload = { version: LOADER_HANDOFF_VERSION, path: meta.path, data: [], denied: handoff.status };
    }
    if (payload === null)
    {
        return '';
    }
    const stamped: LoaderHandoff = { ...payload };
    if (meta.build !== undefined)
    {
        stamped.build = meta.build;
    }
    if (meta.static === true)
    {
        stamped.static = true;
    }
    else if (meta.at !== undefined)
    {
        stamped.at = meta.at;
    }
    return `<script type="application/json" id="${ LOADER_HANDOFF_ID }">${ inertJson(stamped) }</script>`;
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
