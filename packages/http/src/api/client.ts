/**
 * MODULE: api/client - the fully inferred client over a shared contract
 *
 * `createClient(contract, { baseUrl })` yields a call surface mirroring the contract tree:
 * `client.users.create({ input })` - argument and return types inferred from the SAME
 * declaration the server implements, so a drifted call site is a compile error. The
 * contract carries no handler code; this module imports nothing beyond it and speaks plain
 * fetch, so it runs in browsers, workers, Node, and tests unchanged.
 *
 * Inputs are validated BEFORE the request leaves (the schemas are the same isomorphic
 * rules the browser form ran - rejecting locally is free and saves a round trip); the
 * server validates again regardless, because clients lie.
 *
 * A non-2xx answer throws {@link ApiError} carrying the wire shape's stable `code` and -
 * for validation failures - the field-error map, which is EXACTLY what the form's setError
 * consumes: server-side rejection lands in the form with one assignment.
 *
 * The `fetch` option swaps the transport. Passing an App's `handle` runs the whole
 * client/server round trip IN PROCESS - integration tests with zero sockets, full types.
 */

import { SchemaError } from '@azerothjs/schema';
import { isRoute, isMultipartSpec, responseSchemaFor, type AnyRoute, type Contract, type PathParams, type Route } from './define.ts';
import { parseAny } from './validate.ts';

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
     * The per-issue detail of a validation failure: path, machine code, message. Lifted out of
     * `details` alongside `fields` because the server sends both for a 422 and the client
     * produces both for the local case - so code that branches on an issue CODE rather than a
     * message should not have to reach through an `unknown`.
     */
    public readonly issues: ReadonlyArray<{ path: string; code: string; message: string }>;

    /** The full `error.details` payload, for anything beyond code/message/fields/issues. */
    public readonly details: unknown;

    constructor(status: number, code: string, message: string, details: unknown)
    {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        const payload = details as { fields?: Record<string, string>; issues?: ReadonlyArray<{ path: string; code: string; message: string }> } | undefined;
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
 * so `client.health()` rather than `client.health({})` - and every other route takes exactly the
 * parts it declared, which is what makes a forgotten `input` a compile error.
 */
export type Call<Path extends string, In, Out, Query> =
    IsEmpty<CallArgs<Path, In, Query> & object> extends true
        ? () => Promise<Out>
        : (args: CallArgs<Path, In, Query>) => Promise<Out>;

/** The whole contract as a typed client surface. */
export type ClientOf<Shape extends Contract> =
    {
        [K in keyof Shape]:
        Shape[K] extends Route<infer Path, infer In, infer Out, infer Query>
            ? Call<Path, In, Out, Query>
            : Shape[K] extends Contract ? ClientOf<Shape[K]> : never;
    };

/** How {@link createClient} reaches the server: the base URL, an optional transport, headers. */
export interface ClientOptions
{
    /** Where the API is mounted, e.g. '/api' or 'https://host/api'. */
    baseUrl: string;

    /** The transport (default: global fetch). Pass an App's `handle` for in-process tests. */
    fetch?: (request: Request) => Promise<Response>;

    /** Headers added to every call (auth tokens live here). */
    headers?: Record<string, string>;

    /**
     * Check a 2xx body against the route's declared response schema before returning it
     * (default true). The contract's response half is otherwise a compile-time promise only, so a
     * proxied, cached, MITM'd or legacy upstream's body would be handed to the caller as
     * contract-shaped data with nothing having checked it. Set false when the contract describes
     * a server you do not control, which is the one case where a mismatch is expected rather
     * than a bug.
     */
    validateResponses?: boolean;

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

/** Builds the typed client for a contract. */
export function createClient<Shape extends Contract>(contract: Shape, options: ClientOptions): ClientOf<Shape>
{
    const transport = options.fetch ?? ((request: Request): Promise<Response> => fetch(request));
    const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    const validate = options.validateResponses !== false;
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    const build = (node: Contract): Record<string, unknown> =>
    {
        const surface: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node))
        {
            surface[key] = isRoute(child)
                ? (args: RawArgs = {}): Promise<unknown> => call(child, args)
                : build(child);
        }
        return surface;
    };

    const call = async (routeDef: AnyRoute, args: RawArgs): Promise<unknown> =>
    {
        if (routeDef.input !== undefined && isMultipartSpec(routeDef.input))
        {
            // A multipart route's input is FormData, not JSON - the typed client would
            // silently JSON-encode the files. Post FormData with fetch directly instead.
            throw new Error(`The route ${ routeDef.method as string } ${ routeDef.path as string } takes multipart/form-data; `
                + 'the typed client only speaks JSON. Post a FormData body with fetch directly.');
        }
        // Pre-validate locally: the same schema unification the server boundary runs
        // (validate.ts), but the failure costs no network.
        //
        // It reports as ApiError, exactly as a server refusal does. Throwing SchemaError here
        // made one logical failure arrive as two types - and only the server one carried
        // `status`/`code`, so `instanceof ApiError` missed the local case and callers fell back
        // to duck-typing `err.message`. The status and code are the pair the SERVER sends for
        // this same failure, so a caller cannot tell (or need to tell) where it was caught, and
        // `fields` stays the form-ready map that made SchemaError worth reaching for.
        let body = args.input;
        if (routeDef.input !== undefined)
        {
            const parsed = await parseAny(routeDef.input, body);
            if (!parsed.ok)
            {
                const failure = new SchemaError(parsed.errors, parsed.issues);
                throw new ApiError(422, 'validation-failed', failure.message, { fields: parsed.errors, issues: parsed.issues });
            }
            body = parsed.value;
        }

        // AnyRoute erases Path to any (see define.ts); the assertion restores the runtime truth.
        let path: string = routeDef.path as string;
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

        // `redirect: 'error'` because a contract route never legitimately answers with a redirect
        // the typed client should follow. The fetch default is 'follow', which carries the
        // headers configured above - an API key, not just the Authorization the spec strips - to
        // whatever origin the Location names, and then resolves with that origin's body typed as
        // this route's declared output.
        const init: RequestInit = { method: routeDef.method, headers: { ...options.headers }, redirect: 'error' };
        if (body !== undefined)
        {
            init.body = JSON.stringify(body);
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

        const value = await readJsonBounded(response, maxBytes);
        const schema = responseSchemaFor(routeDef, response.status);
        if (validate && schema !== undefined)
        {
            const checked = await parseAny(schema, value);
            if (!checked.ok)
            {
                throw new ApiError(response.status, 'response-contract-violation',
                    'The response does not match the shape this route declares.', { issues: checked.issues });
            }
            return checked.value;
        }
        return value;
    };

    return build(contract) as ClientOf<Shape>;
}
