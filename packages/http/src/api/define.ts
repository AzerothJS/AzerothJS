/**
 * MODULE: api/define - the contract: one shared declaration, both sides of the wire
 *
 * An API is declared as a CONTRACT - a plain value of routes (method + path + input/query/
 * output schemas) with NO handler code - in a file both sides import:
 *
 *   - the client (client.ts) walks the contract to spell real REST calls with full
 *     inference AND validates inputs before they ever leave the browser - the schemas are
 *     the same isomorphic rules the form ran, so this costs no second source of truth;
 *   - the server mounts it with `mountApi(app, contract, { guards, handlers })` - handler
 *     signatures are DERIVED from the contract (a drifted return is a compile error at the
 *     definition site), and a guard's context additions flow into the handlers it protects,
 *     typed, with no cast (guard(), HandlersWithGuards; see mount.ts).
 *
 * Why a shared VALUE and not a type-only import: types erase. A client built from
 * `typeof api` alone cannot know methods and paths at runtime; the alternatives are a
 * manifest fetch (a second source of truth), a codegen step (drift plus a build stage), or
 * collapsing REST into RPC-by-tree-path. The contract IS the single source of truth, it
 * contains nothing a browser must not see, and it makes client-side pre-validation free.
 *
 * Path parameters are typed from the pattern string exactly like the HTTP router
 * (`/users/:id` gives `{ id: string }`); the type is duplicated here rather than imported
 * so this module and the client depend on nothing but @azerothjs/schema.
 */

import type { StandardSchemaV1 } from '@azerothjs/schema';

/**
 * A route boundary schema: any Standard Schema v1 validator (https://standardschema.dev - the
 * `~standard` property Zod, Valibot, ArkType and the house schema all expose).
 *
 * There is ONE schema concept at a boundary. The native `@azerothjs/schema` value is one of these
 * and additionally self-describes, so consumers use its extras when present (`safeParse`: one pass
 * with issue codes; `meta`: the OpenAPI description) and never require them. A foreign schema still
 * validates; its OpenAPI entry degrades to the permissive shape because there is no `meta` to walk.
 */
export type RouteSchema<T> = StandardSchemaV1<T>;

/** Infers the param object type from a route pattern string (mirrors @azerothjs/http). */
export type PathParams<Path extends string> =
    Path extends `${ infer Head }/${ infer Rest }`
        ? PathParams<Head> & PathParams<Rest>
        : Path extends `:${ infer Name }`
            ? Name extends '' ? object : { [K in Name]: string }
            : Path extends `*${ infer Name }`
                ? Name extends '' ? object : { [K in Name]: string }
                : object;

// QUERY (RFC 10008) is a safe, idempotent method that carries a request body - a read whose
// parameters are too large or structured for a URL. On a QUERY route, `input` is that body (the
// query document), validated exactly as a POST body is; the handler MUST NOT mutate state.
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'QUERY';

/**
 * Display-only documentation for one route. NOTHING here affects mounting, validation,
 * or the client - by contract, not just by convention: the OpenAPI exporter is the only
 * consumer. What a machine can derive (operation ids from tree keys, parameters from the
 * pattern, schemas from the declarations) is never repeated here; `docs` carries only
 * what a machine cannot know.
 */
export interface RouteDocs
{
    /** One-line summary shown beside the operation. */
    summary?: string;

    /** Longer prose (CommonMark). */
    description?: string;

    /** Grouping tags; defaults to the route's top-level contract group key. */
    tags?: readonly string[];

    /** Marks the operation deprecated in the spec. */
    deprecated?: boolean;

    /**
     * Error responses this handler can produce beyond the framework-derived set
     * (422/415/500). Status plus prose - the body is always the error envelope.
     */
    errors?: ReadonlyArray<{ status: number; code?: string; description?: string }>;

    /** Names of securitySchemes (from the export options) this route requires; [] = public. */
    security?: ReadonlyArray<string>;
}

/** @internal The brand distinguishing a multipart input spec from a validating schema. */
export const MULTIPART: unique symbol = Symbol('azerothjs.api.multipart');

/**
 * One uploaded file as a contract-level multipart handler receives it. Structurally
 * identical to @azerothjs/http's UploadedFile (mountApi passes those through verbatim);
 * declared here so contract files - which browsers import - stay a pure schema+api affair.
 */
export interface ContractFile
{
    /** The form field name this file was posted under. */
    name: string;

    /** The client-supplied filename, verbatim. UNTRUSTED: sanitize before touching a filesystem. */
    filename: string;

    /** The part's declared Content-Type (application/octet-stream when the client omits it). */
    contentType: string;

    /** The raw file bytes. */
    data: Uint8Array;
}

/** What a multipart route's handler receives as `input`: validated text fields plus the files. */
export interface MultipartInput<Fields = Record<string, string>>
{
    /** The text fields - validated by the `fields` schema, or the raw first-value map without one. */
    fields: Fields;

    /** File parts in posted order. */
    files: ContractFile[];
}

/** How {@link multipart} shapes the parse: field validation plus the byte/part caps. */
export interface MultipartConfig<Fields>
{
    /**
     * Validates the TEXT fields (first value wins for repeated names, like query).
     * Failures are the same 422 field map every other boundary speaks.
     */
    fields?: RouteSchema<Fields>;

    /** Total body cap in bytes (default 8 MiB). */
    limit?: number;

    /** Maximum number of parts (default 256). */
    maxParts?: number;

    /** Per-file cap in bytes (default: the total limit). */
    maxFileSize?: number;
}

/** @internal The runtime shape behind a multipart input spec. */
export interface MultipartSpecShape
{
    readonly [MULTIPART]: true;
    fields?: RouteSchema<unknown>;
    limit?: number;
    maxParts?: number;
    maxFileSize?: number;
}

/**
 * Declares a route's input as multipart/form-data - the contract-level file route:
 *
 * ```ts
 * upload: route({
 *     method: 'POST', path: '/files',
 *     input: multipart({ fields: object({ title: string() }), maxFileSize: 20 * 1024 * 1024 }),
 *     output: FileRecord
 * })
 * ```
 *
 * The handler's `input` is `{ fields, files }`: fields validated against the schema (422 on
 * failure, same field map as JSON routes), files buffered within the caps. A non-multipart
 * POST to the route is a 415. Beyond-memory uploads keep using `streamMultipart` on
 * `context.request` in a raw handler - the buffered contract form is for form-with-files
 * scale, not media ingest. The typed CLIENT does not speak multipart (a browser posts
 * FormData directly); calling such a route through it is a loud error.
 *
 * The return is TYPED as a route schema of the handler-facing input shape so `route()`
 * infers `In` with no extra machinery; at runtime mountApi dispatches on the brand.
 */
export function multipart<Fields = Record<string, string>>(
    config: MultipartConfig<Fields> = {}
): RouteSchema<MultipartInput<Fields>>
{
    const spec: MultipartSpecShape = { [MULTIPART]: true, ...config };
    return spec as unknown as RouteSchema<MultipartInput<Fields>>;
}

/** @internal Whether a route input is a multipart spec (vs a validating schema). */
export function isMultipartSpec(value: unknown): value is MultipartSpecShape
{
    return typeof value === 'object' && value !== null && (value as { [MULTIPART]?: unknown })[MULTIPART] === true;
}

/** @internal The brand distinguishing a typed status reply from an arbitrary object body. */
export const REPLY: unique symbol = Symbol('azerothjs.api.reply');

/**
 * A typed non-default reply: status + body + headers, built with {@link reply}. Unlike a
 * raw `Response`, the body is STILL validated against the route's schema for that status
 * (`responses[status]`, or `output` for 200) - status codes and headers no longer cost
 * the contract its output guarantee.
 */
export interface StatusReply<S extends number = number, B = unknown>
{
    readonly [REPLY]: true;
    status: S;
    body: B;
    headers?: Record<string, string>;
}

/**
 * Builds a typed reply. `reply(201, user, { location })` sends 201 with a validated
 * body; `reply(204)` sends an empty response. The status must be declared in the
 * route's `responses` map (or be 200 with `output`, or carry no body) for the body
 * type to check.
 */
export function reply<S extends number>(status: S): StatusReply<S, undefined>;
export function reply<S extends number, B>(status: S, body: B, headers?: Record<string, string>): StatusReply<S, B>;
export function reply<S extends number, B>(status: S, body?: B, headers?: Record<string, string>): StatusReply<S, B | undefined>
{
    const built: StatusReply<S, B | undefined> = { [REPLY]: true, status, body };
    if (headers !== undefined)
    {
        built.headers = headers;
    }
    return built;
}

/** @internal Whether a handler return is a typed status reply. */
export function isStatusReply(value: unknown): value is StatusReply
{
    return typeof value === 'object' && value !== null && (value as { [REPLY]?: unknown })[REPLY] === true;
}

/**
 * The reply union a route's `responses` map admits: one {@link StatusReply} per declared
 * status with that status's body type, plus `StatusReply<200, Out>` when `output` is
 * declared, plus the always-legal bodyless reply (a 204/205/redirect carries nothing to
 * validate).
 */
/**
 * @internal A `responses` key as its numeric status. Reverse-mapped inference records the
 * literal keys of `{ 404: problem }` as the STRING `"404"` - a plain `& number` on the
 * keyof would erase every status, so this converts instead.
 */
type StatusOf<K> = K extends number ? K : K extends `${ infer N extends number }` ? N : never;

export type ReplyOf<Out, Responses> =
    | (Responses extends Record<PropertyKey, unknown>
        ? { [S in keyof Responses]: StatusReply<StatusOf<S>, Responses[S]> }[keyof Responses]
        : never)
    | StatusReply<200, Out>
    | StatusReply<number, undefined>;

/** One declared route: the wire shape, no behavior. Lives in shared (client-safe) code.
 *  Schemas are native `@azerothjs/schema` OR any Standard Schema validator ({@link RouteSchema}). */
export interface Route<Path extends string = string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>
{
    kind: 'route';
    method: ApiMethod;
    path: Path;
    input?: RouteSchema<In>;
    query?: RouteSchema<Query>;

    /** The 200 response body schema - shorthand for a `responses: { 200: ... }` entry. */
    output?: RouteSchema<Out>;

    /**
     * Response schemas by status: `{ 201: user, 404: problem }`. The route's whole
     * response contract is this map; `output` is the declared shorthand for its 200
     * entry. A handler speaks a non-default status through {@link reply} - validated
     * exactly like a plain return, and each status becomes its own entry in the
     * OpenAPI document.
     */
    responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
    docs?: RouteDocs;
}

/**
 * Any route regardless of its wire types - the shape membership checks compare against.
 * The `any`s are deliberate, for two reasons. Variance: Schema<T> is invariant (T appears in
 * both parameter and return positions), so a bare `Route` - whose generics default to
 * undefined - would reject every route that actually declares an input, output, or query.
 * Inference: the Path slot must be `any` (not `string`), because this type is the Contract
 * index signature that contextually types the object literal inside defineContract - a
 * `string` there PINS the nested route() calls' Path inference to `string`, silently erasing
 * PathParams and collapsing typed client calls to zero-argument. TypeScript ignores `any`
 * contextual positions during inference, which is exactly the behavior needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance-erasing existential; see the doc comment above
export type AnyRoute = Route<any, any, any, any, any>;

/** A contract tree: routes grouped under names, nested arbitrarily. */
export interface Contract
{
    [key: string]: AnyRoute | Contract;
}

/** @internal The methods that carry no request body - the ones `input` is meaningless on. */
type BodylessMethod = 'GET' | 'DELETE';

/**
 * Declares one route from a method value. Identity at runtime; the generics carry the wire
 * types.
 *
 * PREFER THE VERB HELPERS - `get`, `post`, `put`, `patch`, `del`, `query` - which name the
 * method in the call and cover every {@link ApiMethod}. This is the primitive they are built
 * on (the same relationship `app.route` has to `app.get`), and it earns its place for the one
 * thing they cannot do: taking a method that is not a literal, when a contract is assembled
 * from configuration rather than written out.
 *
 * A literal bodyless method is still narrowed here - `route({ method: 'GET', input })` does
 * not compile, exactly as `get('/x', { input })` does not. Only a widened `ApiMethod` falls
 * through to the permissive overload, because at that point the body-ness is unknowable.
 */
export function route<
    Method extends ApiMethod,
    Path extends string,
    In = undefined,
    Out = unknown,
    Query = undefined,
    Responses extends Record<number, unknown> = Record<never, never>
>(
    definition: { method: Method; path: Path } & (Method extends BodylessMethod
        ? BodylessDefinition<Out, Query, Responses>
        : BodyDefinition<In, Out, Query, Responses>)
): Route<Path, Method extends BodylessMethod ? undefined : In, Out, Query, Responses>
{
    return { kind: 'route', ...definition } as Route<Path, Method extends BodylessMethod ? undefined : In, Out, Query, Responses>;
}

/**
 * Declares a contract tree. Identity at runtime; fixes the type both sides derive from.
 * The `const` type parameter keeps literal properties of the fresh object literal from
 * widening; the deeper literal-preservation story (route paths) lives on AnyRoute's doc.
 */
export function defineContract<const Shape extends Contract>(shape: Shape): Shape
{
    assertKeys(shape);
    return shape;
}

/**
 * @internal Every key in the tree must be addressable. The dotted path IS the key space that
 * guards and handlers both use, so a key carrying a `.` is ambiguous by construction: a group
 * `admin` holding `overview` and a top-level key spelled `'admin.overview'` compute the same
 * path, which silently gives one handler two routes and leaks `'admin.*'` guards onto the route
 * that is not in the group. `*` is reserved for the wildcard key space, and an empty key
 * addresses nothing. Checked where the contract is DECLARED, so the error names the author's own
 * literal rather than surfacing at a mount somewhere else.
 */
function assertKeys(node: Contract, trail = ''): void
{
    for (const [key, child] of Object.entries(node))
    {
        const at = trail === '' ? key : `${ trail }.${ key }`;
        if (key === '' || key.includes('.') || key.includes('*'))
        {
            throw new Error(`The contract key "${ key }" (at "${ at }") is not addressable: a key may not be `
                + 'empty or contain "." or "*", because the dotted path is the key space guards and '
                + 'handlers share. Rename it, and use a nested group to express the hierarchy.');
        }
        if (!isRoute(child))
        {
            assertKeys(child, at);
        }
    }
}

/** What the method-sugar factories accept beside the path - everything but the method. */
interface BodylessDefinition<Out, Query, Responses extends Record<number, unknown>>
{
    query?: RouteSchema<Query>;
    output?: RouteSchema<Out>;
    responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
    docs?: RouteDocs;
}

/** As {@link BodylessDefinition}, for the methods that carry a request body. */
interface BodyDefinition<In, Out, Query, Responses extends Record<number, unknown>> extends BodylessDefinition<Out, Query, Responses>
{
    input?: RouteSchema<In>;
}

/** `get('/users/:id', { output })` - sugar for {@link route}; GET carries no body. */
export function get<Path extends string, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: BodylessDefinition<Out, Query, Responses> = {}
): Route<Path, undefined, Out, Query, Responses>
{
    return { kind: 'route', method: 'GET', path, ...definition };
}

/** `post('/users', { input, output })` - sugar for {@link route}. */
export function post<Path extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: BodyDefinition<In, Out, Query, Responses> = {}
): Route<Path, In, Out, Query, Responses>
{
    return { kind: 'route', method: 'POST', path, ...definition };
}

/** `put('/users/:id', { input, output })` - sugar for {@link route}. */
export function put<Path extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: BodyDefinition<In, Out, Query, Responses> = {}
): Route<Path, In, Out, Query, Responses>
{
    return { kind: 'route', method: 'PUT', path, ...definition };
}

/** `patch('/account', { input, output })` - sugar for {@link route}. */
export function patch<Path extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: BodyDefinition<In, Out, Query, Responses> = {}
): Route<Path, In, Out, Query, Responses>
{
    return { kind: 'route', method: 'PATCH', path, ...definition };
}

/** `del('/users/:id')` - sugar for {@link route} (`delete` is a reserved word). */
export function del<Path extends string, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: BodylessDefinition<Out, Query, Responses> = {}
): Route<Path, undefined, Out, Query, Responses>
{
    return { kind: 'route', method: 'DELETE', path, ...definition };
}

/**
 * `query('/search', { input, output })` - a QUERY route; `input` is the query document.
 *
 * A mounted QUERY route answers with a plain validated JSON body. The RFC's `content-location`
 * and cache directives are NOT added for you, because their values are the canonical URL and cache
 * policy of one specific result, which only the handler knows - the kernel's `queryResult` helper
 * takes them as arguments for exactly that reason. Set them from a contract handler with
 * `reply(200, body, { 'content-location': … })`, which keeps output validation.
 *
 * @experimental The QUERY method (RFC 10008) is not yet deployed internet reality -
 * proxies, caches, and tooling may not recognize it. The surface is stable within the
 * 1.x train but carries an experimental flag until the RFC is.
 */
export function query<Path extends string, In = undefined, Out = unknown, Responses extends Record<number, unknown> = Record<never, never>>(
    path: Path, definition: { input?: RouteSchema<In>; output?: RouteSchema<Out>; responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> }; docs?: RouteDocs } = {}
): Route<Path, In, Out, undefined, Responses>
{
    return { kind: 'route', method: 'QUERY', path, ...definition };
}

/** @internal Discriminates a route from a nested group. */
export function isRoute(node: AnyRoute | Contract): node is AnyRoute
{
    return (node as { kind?: unknown }).kind === 'route';
}

/**
 * @internal THE rule for which schema validates a given status: the `responses` map, with `output`
 * as the declared shorthand for its 200 entry.
 *
 * It lives here because two consumers must agree on it - the mount validates a handler's return
 * against it, and the OpenAPI exporter describes the same status from it. Written twice, they
 * could drift, and a spec that disagrees with what the server enforces is worse than no spec.
 */
export function responseSchemaFor(route: AnyRoute, status: number): unknown
{
    const declared = (route.responses as Record<number, unknown> | undefined)?.[status];
    return declared ?? (status === 200 ? route.output : undefined);
}

/** @internal Every route in a group with `Prefix` prepended to its path. */
type Prefixed<Routes extends Contract, Prefix extends string> = {
    [K in keyof Routes]:
    Routes[K] extends Route<infer P, infer In, infer Out, infer Query, infer Responses>
        ? Route<`${ Prefix }${ P & string }`, In, Out, Query, Responses>
        : Routes[K] extends Contract ? Prefixed<Routes[K], Prefix> : never;
};

/**
 * Prepends a shared path prefix to a group of routes, so a service writes its base once:
 *
 * ```ts
 * export const consoleRoutes = group('/admin', {
 *     signIn:   post('/session', { input: adminKeyInput }),
 *     overview: get('/overview', { output: adminOverview })
 * });
 * ```
 *
 * Paths stay explicit strings - the prefix is prepended, never inferred from the key names,
 * because a key and its path legitimately differ (`signIn` answers `/admin/session`). Path
 * PARAMS still type through, so `group('/admin', { one: get('/x/:id') })` gives `{ id: string }`.
 */
export function group<const Routes extends Contract, const Prefix extends string>(
    prefix: Prefix, routes: Routes
): Prefixed<Routes, Prefix>
{
    const out: Contract = {};
    for (const [key, node] of Object.entries(routes))
    {
        out[key] = isRoute(node)
            ? { ...node, path: `${ prefix }${ node.path as string }` } as AnyRoute
            : group(prefix, node);
    }
    return out as Prefixed<Routes, Prefix>;
}

/**
 * Merges route groups into one, THROWING on a duplicate key.
 *
 * Assembling a group with object spread - `{ ...consoleRoutes, ...settingsRoutes }` - silently
 * drops a route when two features happen to share a key, because spread is last-wins. The route
 * vanishes from the contract, so its handler vanishes with it and the mount's coverage check still
 * passes; the router only notices if the two also share a method and path. That is a route quietly
 * disappearing from an API, which is worth a loud boot failure instead.
 */
export function merge<const Groups extends ReadonlyArray<Contract>>(
    ...groups: Groups
): UnionToIntersection<Groups[number]>
{
    const out: Contract = {};
    for (const routes of groups)
    {
        for (const [key, node] of Object.entries(routes))
        {
            // Own-property only: `in` walks the prototype, so a legitimate route keyed `toString`
            // or `constructor` reported a duplicate against Object.prototype on the first group.
            if (Object.hasOwn(out, key))
            {
                throw new Error(`Duplicate contract key "${ key }" while merging route groups. Two groups `
                    + 'declare it, so one route would be silently dropped - rename one of them.');
            }
            out[key] = node;
        }
    }
    return out as UnionToIntersection<Groups[number]>;
}

/**
 * THE context a contract handler receives - the single argument, exactly like a plain
 * http handler, with the validated `input`/`query` added where the contract declared a
 * schema. Whatever the mount's guards attach lands FLAT on this same object; a handler
 * behind a guard narrows at the use site: `(context as typeof context & Authed).accountId`.
 * The documented parameter name is `context`.
 */
export interface HandlerContext<Path extends string, In, Query>
{
    /** The raw web-standard Request: headers, cookies, body, signal. */
    request: Request;

    /** The parsed request URL. */
    url: URL;

    /** Decoded path parameters, typed from the pattern. */
    params: PathParams<Path> & Record<string, string>;

    /** The validated input body (undefined when the route declares no input schema). */
    input: In;

    /** The validated query object (undefined when the route declares no query schema). */
    query: Query;
}

// Typed guards: a guard's context additions flow into the handler's context TYPE,
// and the `guards` map's keys are CHECKED against the contract tree. Both fall out
// of one fact - the unified mount is the single place where the contract, the
// guards, and the handlers meet, so it is the only place the types can compose.

/**
 * A guard for the unified mount. It reads the context and returns an object to ADD to it (typed -
 * `Add` flows into every guarded handler's context), a Response to short-circuit, or nothing.
 *
 * Any plain `(context) => void | Response` is a guard: {@link guard} is only needed when the guard
 * ADDS to the context and that addition has to be inferred.
 */
export interface Guard<Add = Record<never, never>>
{
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps a bare-return guard (adds nothing, only throws/short-circuits) assignable
    (context: GuardContext): Add | Response | undefined | void | Promise<Add | Response | undefined | void>;
}

/**
 * A guard whose every path either attaches `Add` or short-circuits: no branch returns nothing, so
 * a handler behind it reads the fields as definitely present. The difference from {@link Guard} is
 * stated where it is checkable - this return type carries no `undefined` and no `void`.
 *
 * {@link guard} returns this shape automatically when the callback proves it.
 */
export interface ExactGuard<Add>
{
    (context: GuardContext): Add | Response | Promise<Add | Response>;
}

/**
 * The minimal context a guard reads (the http RequestContext, structurally). The equivalence is
 * load-bearing: it is what lets a plain `(context: RequestContext) => void` middleware be used as
 * a guard with no wrapper, so anything added to `RequestContext` belongs here too.
 */
export interface GuardContext
{
    request: Request;
    url: URL;
    params: Record<string, string>;

    /**
     * The path the router matched, decoded and slash-collapsed. A guard is exactly the place this
     * matters: deciding on `url.pathname` lets `/%61dmin` or `//admin` read as a different path
     * than the one whose handler is about to run.
     */
    path: string;
}

/**
 * @internal The guard shape a callback's return type PROVES. Nothing `undefined`/`void` on the
 * awaited return means every path attaches, which is an {@link ExactGuard}; otherwise the guard
 * may attach nothing and the plain {@link Guard} shape says so.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- detecting `void` IS the rule here: a callback with a bare return infers it
type GuardOf<R> = [Extract<Awaited<R>, undefined | void>] extends [never]
    ? ExactGuard<Exclude<Awaited<R>, Response>>
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- same: the union is what is being excluded
    : Guard<Exclude<Awaited<R>, Response | undefined | void>>;

/**
 * Declares a typed guard. `guard((context) => ({ accountId: 7 }))` returns an
 * `ExactGuard<{ accountId: number }>` whose additions the unified mount threads into every handler
 * it protects - no cast at the use site.
 *
 * A guard with a conditional `return;` - the everyday optional-session guard - returns a
 * `Guard<{ accountId: number }>` instead, and the mount types that addition OPTIONAL. That is the
 * runtime truth: on the anonymous path nothing was ever assigned onto the context, so a handler
 * reading `context.accountId` as a `number` there is reading `undefined` through a type that swore
 * otherwise. Narrowing at the handler is the fix, and this is what makes the compiler ask for it.
 */
export function guard<R>(fn: (context: GuardContext) => R): GuardOf<R>
{
    return fn as GuardOf<R>;
}

/** @internal Dotted tree paths of every ROUTE in the contract (`'account.me'`). */
type RoutePaths<Shape, Prefix extends string = ''> = {
    [K in keyof Shape & string]:
    Shape[K] extends AnyRoute ? `${ Prefix }${ K }`
        : Shape[K] extends Contract ? RoutePaths<Shape[K], `${ Prefix }${ K }.`> : never;
}[keyof Shape & string];

/** @internal Group-wildcard keys (`'account.*'`) for every non-leaf branch. */
type GroupWildcards<Shape, Prefix extends string = ''> = {
    [K in keyof Shape & string]:
    Shape[K] extends AnyRoute ? never
        : Shape[K] extends Contract ? `${ Prefix }${ K }.*` | GroupWildcards<Shape[K], `${ Prefix }${ K }.`> : never;
}[keyof Shape & string];

/** The keys a `guards` map may use: any route path, any group wildcard, or the global `'*'`. */
export type GuardKey<Shape extends Contract> = RoutePaths<Shape> | GroupWildcards<Shape> | '*';

/** @internal The brand marking a guard list as the COMPLETE chain for its route. */
export const ONLY: unique symbol = Symbol('azerothjs.api.only');

/**
 * A guard list that REPLACES everything its route would otherwise inherit. Built by {@link only}.
 *
 * It is a WRAPPER OBJECT rather than a branded array, deliberately. A brand carried as a property
 * on an array survives at runtime but is erased by ANY widening annotation - a
 * `ReadonlyArray<Guard>` variable, a `GuardMap`-annotated map, a helper's declared return - and an
 * erased brand means the mount drops the inherited chain while the handler is still typed with the
 * additions of guards that never ran. That is precisely the bug `only` exists to prevent. Not
 * being an array makes such an assignment a compile error rather than a silent disagreement.
 */
export interface OnlyGuards<G extends ReadonlyArray<Guard> = ReadonlyArray<Guard>>
{
    readonly [ONLY]: true;
    readonly guards: G;
}

/**
 * One `guards` map entry: an ordinary chain, which INHERITS what its group and `'*'` add, or an
 * {@link only} list, which replaces them.
 */
export type GuardEntry = ReadonlyArray<Guard> | OnlyGuards;

/** @internal The chain inside an entry - an `only` wrapper carries its list, a plain entry IS one. */
type ListOf<Entry> = Entry extends OnlyGuards<infer G> ? G : Entry;

/**
 * Declares a route's guards as its COMPLETE chain, ignoring what its group and the global
 * `'*'` would otherwise add. It is the exception that makes group guards usable:
 *
 * ```ts
 * guards: {
 *     'admin.*': [requireAdmin],                       // every admin route
 *     'admin.signIn': only([guard(throttle(10, 60_000))])   // except this one - it IS the way in
 * }
 * ```
 *
 * Without it, guarding a group means listing every member by hand so the one exception can be
 * left out, and a route added later is silently unguarded - the failure mode worth designing
 * against. With it, the wildcard covers the group by default and each exception is visible and
 * greppable. The opt-out is deliberately EXACT-PATH only: a wildcard that could cancel another
 * wildcard would make a route's real chain depend on declaration order.
 */
export function only<const G extends ReadonlyArray<Guard>>(guards: G): OnlyGuards<G>
{
    return { [ONLY]: true, guards: [...guards] as unknown as G };
}

/** @internal Whether a guards-map entry replaces the inherited chain. */
export function isOnly(value: unknown): value is OnlyGuards
{
    return typeof value === 'object' && value !== null && (value as { [ONLY]?: unknown })[ONLY] === true;
}

/** A guards map for a contract - keys constrained to real paths, values guard arrays. */
export type GuardMap<Shape extends Contract> = Partial<Record<GuardKey<Shape>, GuardEntry>>;

/** @internal Does guard key `Key` match route path `Path`? ('*', exact, or a `${prefix}.*`). */
type KeyMatches<Key extends string, Path extends string> =
    Key extends '*' ? true
        : Key extends Path ? true
            : Key extends `${ infer Prefix }.*` ? (Path extends `${ Prefix }.${ string }` ? true : false)
                : false;

/**
 * @internal What ONE guard contributes: whatever it can return that is neither a short-circuit
 * nor nothing. A guard that can ALSO return nothing contributes its additions OPTIONALLY, because
 * on that path no `Object.assign` ever ran. A pure gate contributes `never`, which drops out of
 * the union the chain intersects.
 */
type AddOfOne<G> = G extends (...args: never[]) => infer R
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- detecting `void` IS the rule: a pure gate infers it and must contribute nothing
    ? ([Extract<Awaited<R>, undefined | void>] extends [never]
        ? Exclude<Awaited<R>, Response>
        // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- same: the union is what is being excluded
        : Partial<Exclude<Awaited<R>, Response | undefined | void>>)
    : never;

/** @internal An empty chain intersects to `unknown`; say "adds nothing" instead. */
type AsAdditions<A> = [A] extends [never] ? Record<never, never> : unknown extends A ? Record<never, never> : A;

/**
 * @internal A guard chain's combined additions: the INTERSECTION of every guard's, because the
 * mount `Object.assign`s each guard's return onto the ONE context in turn, so two guards that
 * both add leave BOTH fields on it. A union would model that as "one or the other" and let a
 * handler miss a field the chain guarantees.
 */
type AddOf<Entry> = ListOf<Entry> extends infer Guards
    ? (Guards extends ReadonlyArray<unknown>
        ? AsAdditions<UnionToIntersection<AddOfOne<Guards[number]>>>
        : Record<never, never>)
    : Record<never, never>;

/**
 * @internal The additions one route's guards contribute. A route whose EXACT entry is an
 * {@link only} list takes that list's additions alone - the runtime drops the inherited chain
 * for it, so the type must too, or a handler would read a field no guard ever attached.
 */
type AdditionsFor<Path extends string, Guards> =
    Path extends keyof Guards
        ? (Guards[Path] extends OnlyGuards ? AddOf<Guards[Path]> : InheritedAdditions<Path, Guards>)
        : InheritedAdditions<Path, Guards>;

/** @internal The intersection of every matching guard's additions for one route path. */
type InheritedAdditions<Path extends string, Guards> = UnionToIntersection<
    { [Key in keyof Guards & string]: KeyMatches<Key, Path> extends true ? AddOf<Guards[Key]> : never }[keyof Guards & string]
> extends infer R ? (R extends Record<string, unknown> ? R : Record<never, never>) : Record<never, never>;

/** @internal Turns a union into an intersection (the standard contravariant-inference trick). */
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** @internal One route's handler signature: its context, plus whatever its guards add. */
type HandlerFor<R, Add> =
    R extends Route<infer P, infer In, infer Out, infer Query, infer Responses>
        ? (context: HandlerContext<P, In, Query> & Add) =>
        Out | ReplyOf<Out, Responses> | Response | Promise<Out | ReplyOf<Out, Responses> | Response>
        : never;

/**
 * @internal Flattens a contract tree into one entry per leaf, keyed by dotted path. Each entry is
 * built from `Shape[K]` directly rather than by looking the path back up: `Contract` carries an
 * index signature, so indexing a Shape that is still a generic parameter resolves to that
 * signature (`AnyRoute | Contract`) instead of the declared property, and every handler's context
 * would degrade to `never`. Walking with an accumulated prefix keeps the concrete property type.
 */
type FlattenHandlers<Shape, Guards, Add, Prefix extends string> = UnionToIntersection<
    {
        [K in keyof Shape & string]:
        Shape[K] extends AnyRoute
            ? { [P in `${ Prefix }${ K }`]: HandlerFor<Shape[K], Add extends 'guards' ? AdditionsFor<P, Guards> : Add> }
            : Shape[K] extends Contract ? FlattenHandlers<Shape[K], Guards, Add, `${ Prefix }${ K }.`> : never;
    }[keyof Shape & string]
>;

/**
 * The handlers a contract demands under a given guards map, keyed by DOTTED ROUTE PATH - the same
 * key space `guards` uses. Flat by design: the tree is declared once, in the contract, and a
 * handler map that mirrored it would be a second place to keep that shape right.
 */
export type HandlersWithGuards<Shape extends Contract, Guards> =
    FlattenHandlers<Shape, Guards, 'guards', ''>;

/**
 * The handlers one ROUTE GROUP demands, derived from that group alone and keyed by the group's own
 * dotted paths. `Add` is whatever the guards protecting it contribute; the default is nothing.
 */
export type HandlersOf<Routes extends Contract, Add = Record<never, never>> =
    FlattenHandlers<Routes, Record<never, never>, Add, ''>;

/**
 * Types a feature's handlers against its OWN routes. Identity at runtime.
 *
 * A feature owning part of a larger contract used to describe its handlers by reaching for the
 * assembled tree and narrowing it - `Pick<HandlersWithGuards<typeof contract, ...>['admin'],
 * 'signIn' | 'overview'>` - which imports the whole contract to say something local, repeats
 * every route name a third time, and hardcodes the guard additions. The result was that
 * handlers ended up hand-annotating their own context, defeating the derivation.
 *
 * A feature knows its own routes; that is enough:
 *
 * ```ts
 * export const consoleHandlers = (deps: Deps) => implement(consoleRoutes, {
 *     signIn: (context) => ...,      // context.input is typed from consoleRoutes
 *     overview: () => ...
 * });
 * ```
 *
 * Keys are the group's own dotted paths, so a nested group inside it reads `'settings.log'`. The
 * result composes into a mount with a plain spread - and because the mount addresses handlers by
 * the contract's dotted path, a feature never states which group it lands under.
 *
 * Pass the guards' additions when the group runs behind one, so the context carries them:
 * `implement<typeof adminRoutes, Authed>(adminRoutes, { ... })`. Missing, extra, or misspelled
 * handler keys are a compile error at the feature, not at the mount.
 */
export function implement<Routes extends Contract, Add = Record<never, never>>(
    routes: Routes, handlers: HandlersOf<Routes, Add>
): HandlersOf<Routes, Add>
{
    // `routes` is inference-only: it fixes `Routes` so `handlers` is checked against it. The
    // runtime value is the handlers object, unchanged.
    void routes;
    return handlers;
}
