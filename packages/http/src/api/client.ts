/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The fully inferred client over a feature's type plus its manifest.
 *
 * `createClient<typeof features>(manifest, { baseUrl })` yields a call surface mirroring the
 * registered record: `client.keys.create({ input })` - argument and return types inferred from
 * the SAME declarations the server runs (`typeof` the features), while the runtime half is the
 * projected {@link Manifest}: method + path per route, no schemas, no handlers, no functions.
 * Beyond those types it imports one runtime function, `useRequest`, so it runs in browsers,
 * workers, Node, and tests unchanged - and a browser bundle importing it can never drag server
 * code along.
 *
 * WHERE A CALL GOES is decided at call time, because one module-scope client is imported by the
 * browser bundle and by the server render of the same page. An explicit `fetch` wins. An
 * absolute baseUrl goes over the wire. A relative one means "this origin": in a browser that is
 * `location`, and on a server it is the request being answered - if that request carries the
 * app's own api in process, the call is dispatched there with the visitor's identity and never
 * opens a socket. A relative baseUrl with neither is a named error rather than a guess.
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

import { useRequest } from 'azerothjs';
import type { Issue } from '@azerothjs/schema';
import type { Decl, Feature, Manifest, ManifestEntry, PathParams } from './declare.ts';
import { apiBridgeOf, bridgeMethodRefusal } from './bridge.ts';

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
 * The wire projection of a declared type. The manifest carries no schemas, so the client
 * cannot revive what JSON flattened: a declared `Date` arrives as its ISO string, and the
 * call's return type says so instead of lying. Everything JSON keeps intact maps to itself.
 */
export type Wire<T> =
    T extends Date ? string
        : T extends ReadonlyArray<infer U> ? Array<Wire<U>>
            : T extends object ? { [K in keyof T]: Wire<T[K]> }
                : T;

/**
 * One route as a client call. A route that declared no params, input or query takes NO argument -
 * so `client.health.ping()` rather than `client.health.ping({})` - and every other route takes
 * exactly the parts it declared, which is what makes a forgotten `input` a compile error.
 */
export type Call<Path extends string, In, Out, Query> =
    IsEmpty<CallArgs<Path, In, Query> & object> extends true
        ? () => Promise<Wire<Out>>
        : (args: CallArgs<Path, In, Query>) => Promise<Wire<Out>>;

/**
 * A server action as a client call: the input object IS the whole argument (an action path
 * carries no params by declaration), so `client.posts.create({ title })` - no args wrapper.
 */
export type ActionCall<In, Out> =
    undefined extends In
        ? () => Promise<Wire<Out>>
        : (input: In) => Promise<Wire<Out>>;

/**
 * One feature as a client namespace: its JSON routes become calls (the full path - feature
 * prefix included - types the params); form/raw/stream routes are filtered OUT at the type
 * level, and the manifest's `kind` marker backs that with a loud runtime refusal.
 */
export type FeatureClient<F> =
    F extends Feature<infer Prefix, infer R>
        ? {
            [K in keyof R as R[K] extends Decl<string, unknown, unknown, unknown, Record<never, never>, 'json' | 'action'> ? K
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance-erasing match; json/action-kind filter
                : R[K] extends Decl<any, any, any, any, any, 'json' | 'action'> ? K : never]:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inference through the variance-erased view
            R[K] extends Decl<infer P, infer In, infer Out, infer Query, any, 'json'>
                ? Call<`${ Prefix }${ P }`, In, Out, Query>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inference through the variance-erased view
                : R[K] extends Decl<any, infer In, infer Out, any, any, 'action'>
                    ? ActionCall<In, Out>
                    : never;
        }
        : never;

/** The whole registered record as a typed client surface: `client.<feature>.<route>(...)`. */
export type ClientOf<Features extends Record<string, Feature>> =
    { [G in keyof Features]: FeatureClient<Features[G]> };

/** How {@link createClient} reaches the server: the base URL, an optional transport, headers. */
export interface ClientOptions
{
    /**
     * Where the API is registered, e.g. '/api' or 'https://host/api'. Absolute means a scheme
     * (`https:`, in any case) or a leading `//`, and an absolute one always goes over the wire;
     * anything else is relative and means "this origin".
     */
    baseUrl: string;

    /**
     * The transport, and the first case of the selection above: it wins over everything,
     * including the in-process bridge, and keeps the inert base a relative baseUrl has always
     * resolved against. Pass an App's `handle` for in-process tests.
     */
    fetch?: (request: Request) => Promise<Response>;

    /** Headers added to every call (auth tokens live here). */
    headers?: Record<string, string>;

    /**
     * Largest response body to read, in bytes (default 1 MiB, matching the server's own default).
     * An unbounded `response.json()` is a memory-exhaustion primitive handed to whatever answered.
     */
    maxResponseBytes?: number;

    /**
     * CSRF auto-header for ACTION calls: in a browser the client mirrors the readable token
     * cookie (`__Host-azcsrf`, then `azcsrf`) into `x-azeroth-csrf` automatically. Pass
     * names to match a renamed `csrfCookie`/`csrfProtect` pair, or `false` to disable.
     */
    csrf?: false | { cookie?: string; header?: string };
}

/** @internal The client's default response cap, matching the server's own body limit. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * @internal Why a relative baseUrl can fail to find an origin on a server. Written once because
 * the two places that hit it - no transport at all, and a group the manifest never had - are the
 * same misconfiguration seen from two sides, and an author chasing one should read the other's
 * list too.
 */
const TRANSPORT_CAUSES = 'Causes: no api is registered on this App or any enclosing request root; '
    + 'no @azerothjs/http request root around this call, and a work unit (ISR produce or regenerate, cron, ws) '
    + 'is not one; a call outside a guard walk, a loader or a per-request render; '
    + 'a build-time prerender, which answers no request; or an SSR bundle that resolved its own copy of '
    + 'azerothjs, so the host installed the ambient request on the other copy - check ssr.external. '
    + 'Pass an absolute baseUrl or an explicit `fetch` transport where none of these can be true.';

/**
 * @internal Reads a JSON body with a byte ceiling. `response.json()` is unbounded, so a hostile
 * or broken upstream can exhaust the caller's memory on a path that has no other check. A body
 * that is not JSON (a gateway's HTML error page on a 200) throws the documented {@link ApiError},
 * never a bare SyntaxError.
 */
async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown>
{
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes)
    {
        throw new ApiError(response.status, 'response-too-large',
            `The response declares ${ declared } bytes, over the ${ maxBytes }-byte limit.`, undefined);
    }
    // The declared length can lie or be absent, so the real size decides - but it has to be
    // decided WHILE reading. `response.text()` is exactly as unbounded as the `response.json()`
    // this function exists to replace: it drains the whole body into one string first, so the
    // ceiling was enforced only after the memory had already been spent. The stream is cancelled
    // at the first byte over, which also stops the upstream transfer.
    //
    // Counting `byteLength` also makes the option mean what it says. The previous check used
    // `text.length` - UTF-16 code units - so a body of 3-byte UTF-8 characters could reach three
    // times the configured cap before tripping it.
    const body = response.body;
    if (body === null)
    {
        return undefined;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        total += value.byteLength;
        if (total > maxBytes)
        {
            await reader.cancel();
            throw new ApiError(response.status, 'response-too-large',
                `The response exceeds the ${ maxBytes }-byte limit.`, undefined);
        }
        chunks.push(value);
    }
    if (total === 0)
    {
        return undefined;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks)
    {
        joined.set(chunk, at);
        at += chunk.byteLength;
    }
    const decoded = new TextDecoder().decode(joined);
    try
    {
        return JSON.parse(decoded);
    }
    catch
    {
        throw new ApiError(response.status, 'malformed-json',
            `The ${ response.status } response body is not JSON.`, undefined);
    }
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
    const baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
    // By URL shape, not by an "http" prefix: a scheme in any case and a leading "//" are both
    // absolute and name somebody else's origin, while a relative path that happens to start with
    // those letters is not.
    const absoluteBase = /^[a-z][a-z0-9+.-]*:/i.test(baseUrl) || baseUrl.startsWith('//');
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const wire = (request: Request): Promise<Response> => fetch(request);

    /**
     * Which transport serves ONE call, and what URL it is handed. Decided per call, because the
     * answer depends on where the call is made from: the same module-scope client is imported by
     * a browser bundle and by a server render, and only the second can be inside a request.
     *
     * An explicit `fetch` is the first case and keeps the inert base, so an app-supplied
     * transport is never handed an authority derived from the request being answered. An
     * absolute baseUrl says "go over the wire" and is never bridged. A relative one means "this
     * origin", which in a browser is `location` and on a server is the request being answered -
     * and if there is no such request, there is no origin to invent.
     */
    const select = (method: string, relative: string): { transport: (request: Request) => Promise<Response>; url: string } =>
    {
        const here = (globalThis as { location?: Location }).location?.href;
        if (options.fetch !== undefined)
        {
            return { transport: options.fetch, url: new URL(relative, here ?? 'http://localhost').toString() };
        }
        if (absoluteBase)
        {
            // Resolved rather than handed over raw: a scheme-relative base carries no scheme of
            // its own, so it takes the page's where there is one and the inert base otherwise.
            return { transport: wire, url: new URL(relative, here ?? 'http://localhost').toString() };
        }
        const ambient = useRequest();
        const bridge = ambient !== null ? apiBridgeOf(ambient) : undefined;
        if (ambient !== null && bridge !== undefined)
        {
            if (method !== 'GET' && method !== 'HEAD')
            {
                throw new Error(bridgeMethodRefusal(method, relative));
            }
            // Against the page's OWN url, so the handler reads the authority it would have read
            // over the wire; the dispatch never opens a socket, so a forged Host dials nothing.
            return { transport: (request: Request): Promise<Response> => bridge.dispatch(request), url: new URL(relative, ambient.url).toString() };
        }
        if (here !== undefined)
        {
            return { transport: wire, url: new URL(relative, here).toString() };
        }
        throw new Error(`The relative baseUrl "${ options.baseUrl }" means "this origin", and there is no origin here: `
            + `${ method } ${ relative } found no ambient request carrying an in-process api bridge, and no browser `
            + `location to resolve against. ${ TRANSPORT_CAUSES }`);
    };

    // The double-submit mirror for action calls: read the token cookie the page's own JS is
    // meant to read (that readability IS the defense) and echo it in the header. Outside a
    // browser there is no document and no ambient cookie jar - nothing to mirror.
    const readCsrfToken = (): string | undefined =>
    {
        if (options.csrf === false)
        {
            return undefined;
        }
        const jar = (globalThis as { document?: { cookie?: string } }).document?.cookie;
        if (jar === undefined)
        {
            return undefined;
        }
        const names = options.csrf?.cookie !== undefined ? [options.csrf.cookie] : ['__Host-azcsrf', 'azcsrf'];
        for (const name of names)
        {
            const part = jar.split('; ').find((candidate) => candidate.startsWith(`${ name }=`));
            if (part !== undefined)
            {
                return decodeURIComponent(part.slice(name.length + 1));
            }
        }
        return undefined;
    };

    const call = async (method: string, template: string, args: RawArgs, action = false): Promise<unknown> =>
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
        if (action)
        {
            const token = readCsrfToken();
            if (token !== undefined)
            {
                const header = (options.csrf !== false ? options.csrf?.header : undefined) ?? 'x-azeroth-csrf';
                init.headers = { ...init.headers as Record<string, string>, [header]: token };
            }
        }

        // The transport only ever sees the absolute form, exactly as a server would.
        const selected = select(method, `${ baseUrl }${ path }${ queryString }`);
        const response = await selected.transport(new Request(selected.url, init));

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

    /** One manifest row as a callable, whichever manifest it came from - this client's, or a bridge's. */
    const callableFor = (group: string, name: string, entry: ManifestEntry): unknown =>
    {
        if (entry.kind === 'action')
        {
            // Directly callable: the input object is the whole argument.
            return (input?: unknown): Promise<unknown> =>
                call(entry.method, entry.path, input === undefined ? {} : { input }, true);
        }
        if (entry.kind !== undefined)
        {
            return (): never =>
            {
                // A form route's input is FormData and a raw/stream route owns its exchange -
                // the JSON client would silently mis-encode all three. The types already
                // filter these out; the marker keeps the refusal loud for untyped callers.
                throw new Error(`The route ${ group }.${ name } (${ entry.method } ${ entry.path }) is a "${ entry.kind }" route; `
                    + 'the typed client only speaks JSON. Use fetch (FormData / EventSource) directly.');
            };
        }
        return (args: RawArgs = {}): Promise<unknown> => call(entry.method, entry.path, args);
    };

    const surface: Record<string, Record<string, unknown>> = {};
    for (const [group, entries] of Object.entries(manifest))
    {
        const namespace: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(entries))
        {
            namespace[name] = callableFor(group, name, entry);
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
                    return (...args: unknown[]): unknown =>
                    {
                        // The hole can be filled from the request itself: a server-side client is
                        // built with `{}` before `register` has run, and the bridge stamped on the
                        // request carries the manifest that was actually installed. Consulted per
                        // call, so import order stops mattering.
                        const ambient = useRequest();
                        const entry = ambient !== null ? apiBridgeOf(ambient)?.manifest[group]?.[name] : undefined;
                        if (entry !== undefined)
                        {
                            return (callableFor(group, name, entry) as (...rest: unknown[]) => unknown)(...args);
                        }
                        throw new Error(`The api group "${ group }" is not in the manifest this client was built with, and `
                            + 'no ambient request carries an in-process api bridge that has it - the manifest was empty '
                            + `(server unreachable when the page booted?) or stale. ${ group }.${ name }() cannot be `
                            + `called. ${ TRANSPORT_CAUSES }`);
                    };
                }
            });
        }
    }) as ClientOf<Features>;
}

/**
 * Lands an {@link ApiError}'s field map on a form. Nested wire paths land on their first
 * dot segment - `items.0.email` on `items` - matching the form's own schema-overlay rule;
 * the first message per field wins. Returns false (form untouched) for anything that is
 * not an ApiError carrying fields, so the caller keeps one honest branch for "the server
 * did not speak validation":
 *
 * ```ts
 * catch (error)
 * {
 *     if (!applyFieldErrors(form, error))
 *     {
 *         form.setError('title', 'Could not reach the server - try again.');
 *     }
 * }
 * ```
 *
 * `setError` is declared in METHOD syntax deliberately: method parameters check
 * bivariantly, which is what lets a FormApi whose setError takes `keyof T` assign here.
 */
export function applyFieldErrors(
    form: { setError(name: string, message: string | null): void },
    error: unknown
): boolean
{
    if (!(error instanceof ApiError))
    {
        return false;
    }
    const entries = Object.entries(error.fields);
    if (entries.length === 0)
    {
        return false;
    }
    const seen = new Set<string>();
    for (const [path, message] of entries)
    {
        const field = path.split('.', 1)[0] ?? path;
        if (field === '' || seen.has(field))
        {
            continue;
        }
        seen.add(field);
        form.setError(field, message);
    }
    return true;
}
