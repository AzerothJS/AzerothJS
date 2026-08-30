/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Typed route handles: the typed layer over plain route objects, the same move the backend
 * contract made with its route factories.
 *
 * The returned handle IS a real route - drop it straight into `createRouter({ routes })` -
 * that additionally carries the path's param types, the loader's data type and the search
 * schema's value type, so:
 *
 *   - `handle.to({ id: '42' }, { search: { tab: 'bio' } })` - a missing or extra param
 *     is a COMPILE error; search keys and value types check against the schema.
 *   - `useLoader(handle)` - `Resource<Data>`, no cast.
 *   - `useSearch(handle)` - the validated, coerced, TYPED query.
 *
 * Plain object routes stay first-class; handles are additive sugar, pay-as-you-go.
 * `.to()` requires an ABSOLUTE path (a handle nested as a child route carries a
 * relative pattern that cannot address a navigation) - the guard throws with the fix.
 */

import type { NavigateTarget, Query, Route, RouteComponent, SearchSchemaLike } from './types.ts';

/**
 * Infers the param object type from a route pattern string: `/users/:id` gives
 * `{ id: string }`, `/docs/*rest` gives `{ rest: string }`. (Mirrors the HTTP
 * router's params typing; duplicated per package boundary, by house precedent.)
 */
export type RoutePathParams<Path extends string> =
    Path extends `${ infer Head }/${ infer Rest }`
        ? RoutePathParams<Head> & RoutePathParams<Rest>
        : Path extends `:${ infer Name }`
            ? Name extends '' ? object : { [K in Name]: string }
            : Path extends `*${ infer Name }`
                ? Name extends '' ? object : { [K in Name]: string }
                : object;

/** @internal Whether a params object type has no keys (a static path). */
type NoParams<Path extends string> = keyof RoutePathParams<Path> extends never ? true : false;

/** What {@link RouteHandle.to} accepts beside the params. */
export interface ToOptions<Search>
{
    /** Typed search params; serialized onto the query string (undefined entries dropped). */
    search?: Partial<Search>;

    /** Fragment, with or without the leading `#`. */
    hash?: string;
}

/**
 * A typed route: a full {@link Route} plus the navigation builder and the phantom
 * types `useLoader`/`useSearch` read. Build one with {@link defineRoute}.
 */
export interface RouteHandle<Path extends string = string, Data = unknown, Search = Record<string, never>> extends Route
{
    path: Path;

    /**
     * Builds a typed {@link NavigateTarget} for this route: params are checked against
     * the pattern, search against the schema. Static paths take no params argument.
     */
    to: NoParams<Path> extends true
        ? (params?: Record<string, never>, options?: ToOptions<Search>) => NavigateTarget
        : (params: RoutePathParams<Path>, options?: ToOptions<Search>) => NavigateTarget;

    /** @internal Phantom carrier for the loader's data type; never a runtime value. */
    readonly __data?: Data;

    /** @internal Phantom carrier for the search schema's value type; never a runtime value. */
    readonly __search?: Search;
}

/** The loader's data type carried by a handle. */
export type LoaderDataOf<H> = H extends RouteHandle<string, infer Data, infer _S> ? Data : unknown;

/** The validated search type carried by a handle. */
export type SearchOf<H> = H extends RouteHandle<string, infer _D, infer Search> ? Search : Record<string, unknown>;

/** What {@link defineRoute} accepts: a {@link Route} minus `path`, with typed loader args and search. */
export interface DefineRouteConfig<Path extends string, Data, Search>
{
    /** Component to render; exactly one of `component`/`lazy` (validated at router boot). */
    component?: RouteComponent;

    /** Code-split alternative to `component`; see {@link Route.lazy}. */
    lazy?: () => Promise<{ default: RouteComponent } | RouteComponent>;

    /** Optional nested routes (plain or handles). */
    children?: Route[];

    /** Optional name for programmatic reference. */
    name?: string;

    /** Free-form metadata, kept verbatim on the match. */
    meta?: Record<string, unknown>;

    /**
     * Typed loader: `params` matches the pattern; the return type becomes the handle's Data.
     *
     * `query` is the schema's OUTPUT when `search` is declared, not the raw query - reading
     * an undeclared key is a type error rather than a silent `undefined`, because the value
     * this loader returns is cached under a key built from the declared subset alone.
     */
    loader?: (args: {
        // Own params are always present. Everything else is OPTIONAL because this handle
        // cannot know its ancestors (a nested path is relative), and a DESCENDANT's param is
        // absent at runtime - the loader is keyed on the params at or above its own level.
        // A flat `Record<string, string>` would type a descendant read as `string` and hand
        // back undefined.
        params: RoutePathParams<Path> & Partial<Record<string, string>>;
        query: [Search] extends [never] ? Query : Search;
        signal: AbortSignal;
        parent: Promise<unknown>;
    }) => Promise<Data>;

    /** Search-param schema; its value type becomes the handle's Search (see {@link Route.search}). */
    search?: SearchSchemaLike<Search>;
}

/**
 * Declares one route with full type flow: params typed from the pattern, data typed from the
 * loader, search typed from the schema. The result is a real {@link Route} that also carries
 * `.to()`.
 *
 * Untyped routing fails exactly where it hurts - a renamed param or a mistyped query key
 * surfaces at runtime, inside a click path. This moves both to compile time without imposing
 * a whole-tree ceremony, so it can be adopted one route at a time.
 *
 * `.to()` requires an ABSOLUTE path. A handle nested as a child route carries a relative
 * pattern that cannot address a navigation, and the guard throws with the fix.
 *
 * @example
 * const userRoute = defineRoute('/users/:id', {
 *     component: UserPage,
 *     loader: async ({ params }) => fetchUser(params.id),
 *     search: object({ tab: enumOf(['posts', 'bio']).optional() })
 * });
 * router.navigate(userRoute.to({ id: '42' }, { search: { tab: 'bio' } }));
 */
export function defineRoute<Path extends string, Data = unknown, Search = Record<string, never>>(
    path: Path, config: DefineRouteConfig<Path, Data, Search>
): RouteHandle<Path, Data, Search>
{
    const to = (params: Record<string, string> = {}, options: ToOptions<Search> = {}): NavigateTarget =>
    {
        if (!path.startsWith('/'))
        {
            throw new Error(`${ path }.to(): only an ABSOLUTE path can address a navigation. `
                + 'Define nested-child handles for structure, but navigate via a handle declared with its full path.');
        }
        const pathname = path.split('/').map((segment) =>
        {
            if (segment.startsWith(':'))
            {
                return encodeURIComponent(params[segment.slice(1)] ?? '');
            }
            if (segment.startsWith('*'))
            {
                return params[segment.slice(1)] ?? '';
            }
            return segment;
        }).join('/');

        let query: Query | undefined = undefined;
        if (options.search !== undefined)
        {
            query = {};
            for (const [key, value] of Object.entries(options.search))
            {
                if (value !== undefined)
                {
                    // Search values are primitives by the schema contract; an object here is
                    // caller error surfaced visibly in the URL.
                    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see above
                    query[key] = Array.isArray(value) ? value.map(String) : String(value);
                }
            }
        }

        const target: { pathname: string; query?: Query; hash?: string } = { pathname };
        if (query !== undefined)
        {
            target.query = query;
        }
        if (options.hash !== undefined)
        {
            target.hash = options.hash;
        }
        return target;
    };

    return {
        path,
        ...config,
        loader: config.loader as Route['loader'],
        to
    } as RouteHandle<Path, Data, Search>;
}
