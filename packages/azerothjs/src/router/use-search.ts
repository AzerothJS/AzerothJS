/**
 * MODULE: router/use-search
 *
 * useSearch returns the current query string VALIDATED through a route's `search`
 * schema: coerced (`number({ coerce: true })` turns `?page=2` into `2`), stripped of
 * undeclared keys, and typed when read through a {@link RouteHandle}. The raw query
 * stays available on `useQuery`/`location().query`; this is the contractual view.
 *
 * DEGRADATION: an invalid query never crashes a route the user reached by URL - the
 * memo returns `{}` (declare search fields optional/defaulted) and warns on the
 * console, once per offending query string.
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
 * useSearch
 *
 * PURPOSE:
 * Returns a getter for the validated, coerced search params - typed via a
 * {@link RouteHandle}, or shaped by the current route's `search` schema.
 *
 * INPUT CONTRACT:
 * - `useSearch(handle, router?)`: validates through the HANDLE's schema; `Getter<Search>`.
 * - `useSearch()` inside a route component: this level's route `search` schema (raw
 *   query passthrough when the route declares none).
 * - `useSearch(router)`: the matched LEAF route's schema, tracking navigation.
 *
 * OUTPUT CONTRACT:
 * - A memo: re-fires when the validated value's inputs change (the query), returning
 *   the schema's value type. Invalid queries degrade to `{}` with one console warning.
 *
 * @example
 * const search = useSearch(userRoute);      // Getter<{ tab?: 'posts' | 'bio' }>
 * h('span', {}, () => search().tab ?? 'posts');
 */
export function useSearch<Path extends string, Data, Search>(handle: RouteHandle<Path, Data, Search>, router?: Router): Getter<Search>;
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
