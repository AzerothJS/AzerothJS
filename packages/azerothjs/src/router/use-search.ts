/**
 * The current query string VALIDATED through a route's `search` schema: coerced, so
 * `number({ coerce: true })` turns `?page=2` into `2`, stripped of undeclared keys, and typed
 * when read through a route handle. The raw query stays available on useQuery; this is the
 * contractual view of it.
 *
 * An invalid query never crashes a route the user reached by URL. The memo returns `{}` and
 * warns once per offending query string, so declare search fields optional or defaulted.
 */

import type { Getter } from '../reactivity/index.ts';
import { createMemo, untrack } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import type { SearchSchemaLike } from './types.ts';
import type { Router } from './router.ts';
import type { RouteHandle } from './define-route.ts';
import { currentRouteFrame, resolveRouter } from './provider.ts';

/** @internal One warning per (schema, search-string) so a hostile URL cannot spam the console. */
const warned = new WeakMap<SearchSchemaLike, string>();

/** @internal Validates one location's query through `schema`, degrading to {} with one warning. */
function parseWith(schema: SearchSchemaLike | undefined, location: { query: unknown; search: string }): unknown
{
    if (schema === undefined)
    {
        return location.query;
    }
    const parsed = schema.safeParse(location.query);
    if (parsed.ok)
    {
        return parsed.value;
    }
    if (DEV && warned.get(schema) !== location.search)
    {
        warned.set(schema, location.search);
        console.warn(`[azerothjs/router] search params "${ location.search }" failed their schema; `
            + `degrading to {}. Fields: ${ Object.keys(parsed.errors ?? {}).join(', ') }`);
    }
    return {};
}

/** @internal Memoizes {@link parseWith} over the live location for a FIXED schema. */
function validated(router: Router, schema: SearchSchemaLike | undefined): Getter<unknown>
{
    return createMemo(() => parseWith(schema, router.location()));
}

/**
 * A getter for the validated, coerced search params, typed through the given route handle.
 *
 * It is a memo over the query, so it re-fires only when the query genuinely changes. An
 * invalid query degrades to `{}` with one console warning rather than throwing, because the
 * user may simply have typed the URL.
 *
 * @param handle - The route handle whose `search` schema validates the query.
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns A getter for the schema's value type.
 * @example
 * const search = useSearch(userRoute); // Getter<{ tab?: 'posts' | 'bio' }>
 *
 * h('span', {}, () => search().tab ?? 'posts');
 */
export function useSearch<Path extends string, Data, Search>(handle: RouteHandle<Path, Data, Search>, router?: Router): Getter<Search>;
/**
 * Untyped form, validating through whichever route's `search` schema applies: this level's
 * inside a route component body, otherwise the matched leaf's, tracking navigation. A route
 * declaring no schema passes the raw query through.
 *
 * @param router - Optional explicit router. Resolved from context when omitted.
 * @returns A getter for the validated query, `{}` when validation fails.
 */
export function useSearch(router?: Router): Getter<Record<string, unknown>>;
export function useSearch(
    first?: Router | RouteHandle<string, unknown, unknown>, second?: Router
): Getter<unknown>
{
    if (first !== undefined && 'path' in first)
    {
        return validated(resolveRouter(second, 'useSearch'), first.search);
    }

    const frame = currentRouteFrame();
    if (first === undefined && frame !== null)
    {
        const route = untrack(() => frame.router.match())?.matched[frame.level];
        return validated(frame.router, route?.search);
    }

    // Explicit/context router outside a chain build: the LEAF route's schema, live.
    const router = resolveRouter(first, 'useSearch');
    return createMemo(() => parseWith(router.match()?.route.search, router.location()));
}
