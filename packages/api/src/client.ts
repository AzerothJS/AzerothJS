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
import { isRoute, type AnyRoute, type Contract, type PathParams, type Route } from './define.ts';

/** The error a failed call throws: the wire shape, typed. */
export class ApiError extends Error
{
    /** The HTTP status. */
    public readonly status: number;

    /** The stable machine-readable code from the wire shape ('validation-failed', ...). */
    public readonly code: string;

    /** The field-path error map of a validation failure - feed it to the form's setError. */
    public readonly fields: Record<string, string>;

    /** The full `error.details` payload, for anything beyond code/message/fields. */
    public readonly details: unknown;

    constructor(status: number, code: string, message: string, details: unknown)
    {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.fields = (details as { fields?: Record<string, string> } | undefined)?.fields ?? {};
    }
}

/** @internal Empty-object detection for argument optionality. */
type IsEmpty<T> = keyof T extends never ? true : false;

/** The argument object one call takes - only the parts its route declared. */
export type CallArgs<Path extends string, In, Query> =
    (IsEmpty<PathParams<Path>> extends true ? unknown : { params: PathParams<Path> })
    & (undefined extends In ? unknown : { input: In })
    & (undefined extends Query ? unknown : { query: Query });

/** One route as a client call; routes declaring nothing take no argument at all. */
export type Call<Path extends string, In, Out, Query> =
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- deliberate always-true distribution guard: the real branch test is the IsEmpty below
    CallArgs<Path, In, Query> extends Record<string, never> | unknown
        ? IsEmpty<CallArgs<Path, In, Query> & object> extends true
            ? () => Promise<Out>
            : (args: CallArgs<Path, In, Query>) => Promise<Out>
        : never;

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
        // Pre-validate locally: same rules as the server, but the failure costs no network.
        // A native schema uses its one-pass safeParse; a Standard Schema validator
        // (Zod/Valibot) is validated on the server, so here it simply passes through.
        let body = args.input;
        const nativeInput = routeDef.input as { safeParse?: (v: unknown) => { ok: true; value: unknown } | { ok: false; errors: Record<string, string>; issues?: Array<{ path: string; code: string; message: string }> } } | undefined;
        if (nativeInput !== undefined && typeof nativeInput.safeParse === 'function')
        {
            const parsed = nativeInput.safeParse(body);
            if (!parsed.ok)
            {
                throw new SchemaError(parsed.errors, parsed.issues);
            }
            body = parsed.value;
        }

        // AnyRoute erases Path to any (see define.ts); the assertion restores the runtime truth.
        let path: string = routeDef.path as string;
        for (const [name, value] of Object.entries((args.params ?? {})))
        {
            path = path.replace(`:${ name }`, encodeURIComponent(value)).replace(`*${ name }`, value);
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

        const init: RequestInit = { method: routeDef.method, headers: { ...options.headers } };
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
            const wire = await response.json().catch(() => null) as
                { error?: { code?: string; message?: string; details?: unknown } } | null;
            throw new ApiError(
                response.status,
                wire?.error?.code ?? 'unknown',
                wire?.error?.message ?? `Request failed with status ${ response.status }`,
                wire?.error?.details
            );
        }
        if (response.status === 204)
        {
            return undefined;
        }
        return response.json();
    };

    return build(contract) as ClientOf<Shape>;
}
