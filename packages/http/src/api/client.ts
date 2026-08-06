/**
 * MODULE: api/client - the fully inferred client over a feature's type plus its manifest
 *
 * `createClient<typeof features>(manifest, { baseUrl })` yields a call surface mirroring the
 * registered record: `client.keys.create({ input })` - argument and return types inferred from
 * the SAME declarations the server runs (`typeof` the features), while the runtime half is the
 * projected {@link Manifest}: method + path per route, no schemas, no handlers, no functions.
 * This module imports types only and speaks plain fetch, so it runs in browsers, workers, Node,
 * and tests unchanged - and a browser bundle importing it can never drag server code along.
 *
 * A non-2xx answer throws {@link ApiError} carrying the wire shape's stable `code` and - for
 * validation failures - the field-error map, which is EXACTLY what the form's setError
 * consumes: server-side rejection lands in the form with one assignment. Input validation
 * happens where input originates: `createForm({ schema })` in the UI, and the server boundary
 * regardless, because clients lie.
 *
 * The `fetch` option swaps the transport. Passing an App's `handle` runs the whole
 * client/server round trip IN PROCESS - integration tests with zero sockets, full types.
 */

import type { Issue } from '@azerothjs/schema';
import type { Decl, Feature, Manifest, PathParams } from './declare.ts';

/** The error a failed call throws: the wire shape, typed. */
export class ApiError extends Error
{
    /** The HTTP status. */
    public readonly status: number;

    /** The stable machine-readable code from the wire shape ('validation-failed', ...). */
    public readonly code: string;

    /** The field-path error map of a validation failure - feed it to the form's setError. */
    public readonly fields: Record<string, string>;

    /**
     * The per-issue detail of a validation failure: path, machine code, message - the ONE issue
     * shape the whole framework speaks. Lifted out of `details` alongside `fields` so code that
     * branches on an issue CODE rather than a message does not have to reach through an `unknown`.
     */
    public readonly issues: ReadonlyArray<Issue>;

    /** The full `error.details` payload, for anything beyond code/message/fields/issues. */
    public readonly details: unknown;

    constructor(status: number, code: string, message: string, details: unknown)
    {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        const payload = details as { fields?: Record<string, string>; issues?: ReadonlyArray<Issue> } | undefined;
        this.fields = payload?.fields ?? {};
        this.issues = payload?.issues ?? [];
    }
}

/** @internal Empty-object detection for argument optionality. */
type IsEmpty<T> = keyof T extends never ? true : false;

/** The argument object one call takes - only the parts its route declared. */
export type CallArgs<Path extends string, In, Query> =
    (IsEmpty<PathParams<Path>> extends true ? unknown : { params: PathParams<Path> })
    & (undefined extends In ? unknown : { input: In })
    & (undefined extends Query ? unknown : { query: Query });

/**
 * One route as a client call. A route that declared no params, input or query takes NO argument -
 * so `client.health.ping()` rather than `client.health.ping({})` - and every other route takes
 * exactly the parts it declared, which is what makes a forgotten `input` a compile error.
 */
export type Call<Path extends string, In, Out, Query> =
    IsEmpty<CallArgs<Path, In, Query> & object> extends true
        ? () => Promise<Out>
        : (args: CallArgs<Path, In, Query>) => Promise<Out>;

/**
 * One feature as a client namespace: its JSON routes become calls (the full path - feature
 * prefix included - types the params); form/raw/stream routes are filtered OUT at the type
 * level, and the manifest's `kind` marker backs that with a loud runtime refusal.
 */
export type FeatureClient<F> =
    F extends Feature<infer Prefix, infer R>
        ? {
            [K in keyof R as R[K] extends Decl<string, unknown, unknown, unknown, Record<never, never>, 'json'> ? K
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance-erasing match; json-kind filter
                : R[K] extends Decl<any, any, any, any, any, 'json'> ? K : never]:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inference through the variance-erased view
            R[K] extends Decl<infer P, infer In, infer Out, infer Query, any, 'json'>
                ? Call<`${ Prefix }${ P }`, In, Out, Query>
                : never;
        }
        : never;

/** The whole registered record as a typed client surface: `client.<feature>.<route>(...)`. */
export type ClientOf<Features extends Record<string, Feature>> =
    { [G in keyof Features]: FeatureClient<Features[G]> };

/** How {@link createClient} reaches the server: the base URL, an optional transport, headers. */
export interface ClientOptions
{
    /** Where the API is registered, e.g. '/api' or 'https://host/api'. */
    baseUrl: string;

    /** The transport (default: global fetch). Pass an App's `handle` for in-process tests. */
    fetch?: (request: Request) => Promise<Response>;

    /** Headers added to every call (auth tokens live here). */
    headers?: Record<string, string>;

    /**
     * Largest response body to read, in bytes (default 1 MiB, matching the server's own default).
     * An unbounded `response.json()` is a memory-exhaustion primitive handed to whatever answered.
     */
    maxResponseBytes?: number;
}

/** @internal The client's default response cap, matching the server's own body limit. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * @internal Reads a JSON body with a byte ceiling. `response.json()` is unbounded, so a hostile
 * or broken upstream can exhaust the caller's memory on a path that has no other check.
 */
async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown>
{
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes)
    {
        throw new ApiError(response.status, 'response-too-large',
            `The response declares ${ declared } bytes, over the ${ maxBytes }-byte limit.`, undefined);
    }
    const text = await response.text();
    // The declared length can lie or be absent, so the real size decides.
    if (text.length > maxBytes)
    {
        throw new ApiError(response.status, 'response-too-large',
            `The response exceeds the ${ maxBytes }-byte limit.`, undefined);
    }
    return text === '' ? undefined : JSON.parse(text);
}

/**
 * @internal A wildcard path segment, encoded per segment so the value cannot leave the route it
 * was called on. `/` survives because a wildcard is legitimately multi-segment; `.` and `..` do
 * not, because `new Request` resolves them and the call would silently execute a DIFFERENT route
 * with this client's auth headers attached, returning that route's body under this route's type.
 */
function encodeWildcard(value: string): string
{
    return value.split('/').map((segment) =>
    {
        if (segment === '.' || segment === '..')
        {
            throw new TypeError(`A wildcard path parameter may not contain a "${ segment }" segment: `
                + 'it would resolve to a different route than the one being called.');
        }
        return encodeURIComponent(segment);
    }).join('/');
}

/** @internal The untyped runtime view of call arguments (typing is ClientOf's job). */
interface RawArgs
{
    params?: Record<string, string>;
    input?: unknown;
    query?: Record<string, unknown>;
}

/**
 * Builds the typed client: the {@link Manifest} supplies each route's method and path, `typeof`
 * the server's features supplies every type. The two come from the same declaration - the
 * manifest is the framework's own projection of it, not a hand-written mirror.
 *
 * ```ts
 * // import type { api } from the server module that called register()
 * const client = createClient<typeof api>(manifest, { baseUrl: '/api' });
 * const key = await client.keys.create({ input: { label: 'ci' } });
 * ```
 */
export function createClient<Features extends Record<string, Feature>>(manifest: Manifest, options: ClientOptions): ClientOf<Features>
{
    const transport = options.fetch ?? ((request: Request): Promise<Response> => fetch(request));
    const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    const call = async (method: string, template: string, args: RawArgs): Promise<unknown> =>
    {
        let path = template;
        for (const [name, value] of Object.entries((args.params ?? {})))
        {
            // Boundary-anchored: a plain substring replace of `:id` would corrupt a sibling
            // param named `:ida` (first-match prefix hit), so the name must end at a
            // non-identifier character.
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            path = path
                .replace(new RegExp(`:${ escaped }(?![A-Za-z0-9_])`), encodeURIComponent(value))
                .replace(new RegExp(`\\*${ escaped }(?![A-Za-z0-9_])`), encodeWildcard(value));
        }

        let queryString = '';
        if (args.query !== undefined)
        {
            const search = new URLSearchParams();
            for (const [key, value] of Object.entries(args.query))
            {
                if (value !== undefined)
                {
                    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- query values are primitives by contract; an object is caller error surfaced visibly in the URL
                    search.set(key, String(value));
                }
            }
            queryString = search.size > 0 ? `?${ search.toString() }` : '';
        }

        // `redirect: 'error'` because a declared route never legitimately answers with a redirect
        // the typed client should follow. The fetch default is 'follow', which carries the
        // headers configured above - an API key, not just the Authorization the spec strips - to
        // whatever origin the Location names, and then resolves with that origin's body typed as
        // this route's declared output.
        const init: RequestInit = { method, headers: { ...options.headers }, redirect: 'error' };
        if (args.input !== undefined)
        {
            init.body = JSON.stringify(args.input);
            init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
        }

        // A relative baseUrl ('/api') resolves against an inert origin - the transport only
        // ever sees the absolute form, exactly as a server would.
        const absolute = baseUrl.startsWith('http') ? `${ baseUrl }${ path }${ queryString }`
            : new URL(`${ baseUrl }${ path }${ queryString }`, (globalThis as { location?: Location }).location?.href ?? 'http://localhost').toString();
        const response = await transport(new Request(absolute, init));

        if (!response.ok)
        {
            const wire = await readJsonBounded(response, maxBytes).catch(() => null) as
                { error?: { code?: string; message?: string; details?: unknown } } | null;
            throw new ApiError(
                response.status,
                typeof wire?.error?.code === 'string' ? wire.error.code : 'unknown',
                typeof wire?.error?.message === 'string' ? wire.error.message : `Request failed with status ${ response.status }`,
                wire?.error?.details
            );
        }
        if (response.status === 204)
        {
            return undefined;
        }
        return readJsonBounded(response, maxBytes);
    };

    const surface: Record<string, Record<string, unknown>> = {};
    for (const [group, entries] of Object.entries(manifest))
    {
        const namespace: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(entries))
        {
            namespace[name] = entry.kind !== undefined
                ? (): never =>
                {
                    // A form route's input is FormData and a raw/stream route owns its exchange -
                    // the JSON client would silently mis-encode all three. The types already
                    // filter these out; the marker keeps the refusal loud for untyped callers.
                    throw new Error(`The route ${ group }.${ name } (${ entry.method } ${ entry.path }) is a "${ entry.kind }" route; `
                        + 'the typed client only speaks JSON. Use fetch (FormData / EventSource) directly.');
                }
                : (args: RawArgs = {}): Promise<unknown> => call(entry.method, entry.path, args);
        }
        surface[group] = namespace;
    }

    // The types promise every group exists, but the VALUE arrives at runtime - an empty
    // manifest (server unreachable at boot, degraded to {}) or a stale one can miss
    // groups the types still declare. Reading such a group yields a trap namespace whose
    // every method throws a designed error at ITS call - pages render, each call fails at
    // its own site naming the cause - instead of `undefined` and a bare TypeError. Real
    // groups stay plain objects: the trap exists only where the manifest has a hole.
    return new Proxy(surface, {
        get(target, group, receiver): unknown
        {
            if (typeof group !== 'string' || group in target || group === 'then')
            {
                return Reflect.get(target, group, receiver);
            }
            return new Proxy({}, {
                get(_missing, name): unknown
                {
                    if (typeof name !== 'string' || name === 'then')
                    {
                        return undefined;
                    }
                    return (): never =>
                    {
                        throw new Error(`The api group "${ group }" is not in the manifest this client was built with - `
                            + 'the manifest was empty (server unreachable when the page booted?) or stale. '
                            + `${ group }.${ name }() cannot be called.`);
                    };
                }
            });
        }
    }) as ClientOf<Features>;
}
