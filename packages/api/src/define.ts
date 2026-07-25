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

import type { Schema, StandardSchemaV1 } from '@azerothjs/schema';

// The Standard Schema v1 contract (https://standardschema.dev) - the `~standard` property
// Zod, Valibot, ArkType (and the house schema itself) expose. A `route()` accepts EITHER a
// native `@azerothjs/schema` Schema (which also self-describes for OpenAPI) OR any Standard
// Schema validator, so a team keeps its existing schemas. A foreign schema validates the
// boundary; its OpenAPI entry degrades to the permissive shape (no `meta` to walk).
export type { StandardSchemaV1 } from '@azerothjs/schema';

/** A route boundary schema: the native self-describing one, or any Standard Schema validator. */
export type RouteSchema<T> = Schema<T> | StandardSchemaV1<T>;

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

    /** The DEFAULT (200) response body schema. */
    output?: RouteSchema<Out>;

    /**
     * Per-status response schemas beyond the 200 default: `{ 201: user, 404: problem }`.
     * A handler speaks them through {@link reply} - validated exactly like `output`, and
     * each becomes its own entry in the OpenAPI document.
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

/** Declares one route. Identity at runtime; the generics carry the wire types. */
export function route<Path extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
    definition: {
        method: ApiMethod;
        path: Path;
        input?: RouteSchema<In>;
        query?: RouteSchema<Query>;
        output?: RouteSchema<Out>;
        responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
        docs?: RouteDocs;
    }
): Route<Path, In, Out, Query, Responses>
{
    return { kind: 'route', ...definition };
}

/**
 * Declares a contract tree. Identity at runtime; fixes the type both sides derive from.
 * The `const` type parameter keeps literal properties of the fresh object literal from
 * widening; the deeper literal-preservation story (route paths) lives on AnyRoute's doc.
 */
export function defineContract<const Shape extends Contract>(shape: Shape): Shape
{
    return shape;
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

/** `query('/search', { input, output })` - a QUERY route; `input` is the query document.  * @experimental The QUERY method (RFC 10008) is not yet deployed internet reality -
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
 * A guard for the unified mount, built by {@link guard}. It reads the context and
 * returns an object to ADD to it (typed - `Add` flows into every guarded handler's
 * context), a Response to short-circuit, or nothing. The `__add` field is a
 * phantom carrier for `Add`; it is never read at runtime.
 */
export interface Guard<Add extends Record<string, unknown> = Record<never, never>>
{
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps a bare-return guard (adds nothing, only throws/short-circuits) assignable
    (context: GuardContext): Add | Response | undefined | void | Promise<Add | Response | undefined | void>;

    /** @internal Phantom: the addition type, extracted by AdditionsFor. Never assigned. */
    readonly __add?: Add;
}

/** The minimal context a guard reads (the http RequestContext, structurally). */
export interface GuardContext
{
    request: Request;
    url: URL;
    params: Record<string, string>;
}

/**
 * Declares a typed guard. `guard((context) => ({ accountId: 7 }))` returns a
 * `Guard<{ accountId: number }>` whose additions the unified mount threads into
 * every handler it protects - no cast at the use site.
 */
export function guard<Add extends Record<string, unknown>>(
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps a bare-return guard assignable
    fn: (context: GuardContext) => Add | Response | undefined | void | Promise<Add | Response | undefined | void>
): Guard<Add>
{
    return fn;
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

/** A guards map for a contract - keys constrained to real paths, values guard arrays. */
export type GuardMap<Shape extends Contract> = Partial<Record<GuardKey<Shape>, ReadonlyArray<Guard>>>;

/** @internal Does guard key `Key` match route path `Path`? ('*', exact, or a `${prefix}.*`). */
type KeyMatches<Key extends string, Path extends string> =
    Key extends '*' ? true
        : Key extends Path ? true
            : Key extends `${ infer Prefix }.*` ? (Path extends `${ Prefix }.${ string }` ? true : false)
                : false;

/** @internal Extract a guard array's combined additions (intersection of each Guard's Add). */
type AddOf<Guards> = Guards extends ReadonlyArray<Guard<infer _A>>
    ? (Guards[number] extends Guard<infer A> ? A : Record<never, never>)
    : Record<never, never>;

/** @internal The intersection of every matching guard's additions for one route path. */
type AdditionsFor<Path extends string, Guards> = UnionToIntersection<
    { [Key in keyof Guards & string]: KeyMatches<Key, Path> extends true ? AddOf<Guards[Key]> : never }[keyof Guards & string]
> extends infer R ? (R extends Record<string, unknown> ? R : Record<never, never>) : Record<never, never>;

/** @internal Turns a union into an intersection (the standard contravariant-inference trick). */
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/** @internal One route's handler, its context intersected with the additions its guards supply. */
type GuardedHandlerFor<R, Path extends string, Guards> =
    R extends Route<infer P, infer In, infer Out, infer Query, infer Responses>
        ? (context: HandlerContext<P, In, Query> & AdditionsFor<Path, Guards>) =>
        Out | ReplyOf<Out, Responses> | Response | Promise<Out | ReplyOf<Out, Responses> | Response>
        : never;

/** The handler tree a contract demands UNDER a given guards map - additions flow into each context. */
export type HandlersWithGuards<Shape extends Contract, Guards, Prefix extends string = ''> = {
    [K in keyof Shape & string]:
    Shape[K] extends AnyRoute ? GuardedHandlerFor<Shape[K], `${ Prefix }${ K }`, Guards>
        : Shape[K] extends Contract ? HandlersWithGuards<Shape[K], Guards, `${ Prefix }${ K }.`> : never;
};
