/**
 * MODULE: api/declare - the client-safe half of the colocated API
 *
 * The types and small values BOTH sides of the wire read: the route declaration shape
 * ({@link Decl}), the projected {@link Manifest} a typed client is built from, path-parameter
 * inference, the typed status reply, the guard TYPE contracts, and multipart's wire shapes.
 * Nothing here touches a server API: this module (and client.ts, which consumes it) is what
 * '@azerothjs/http/api/shared' exposes, so importing that entry can never drag Node code into
 * a browser bundle. feature.ts and register.ts import THIS module - never the reverse; the
 * kernel-purity test text-walks every import specifier, type-only included, so the direction
 * is load-bearing.
 *
 * Why a manifest and not a runtime contract value: types erase, but a type plus two runtime
 * fields per route does not. The client's whole runtime need is method + path; everything else
 * - params, input, query, output - is inference from `typeof` the server's own declaration.
 * The manifest is a projection of that declaration, computed by the framework, so it is not a
 * second source of truth; a ten-route feature's manifest measures in the hundreds of bytes.
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

/**
 * The JSON verbs a declaration may carry. QUERY (RFC 10008) is a safe, idempotent method that
 * carries a request body - a read whose parameters are too large or structured for a URL; its
 * `input` is that body, validated exactly as a POST body is, and the handler MUST NOT mutate
 * state. `raw` routes may use any method string beyond this union.
 */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'QUERY';

/**
 * How a route speaks on the wire - the discriminant every consumer dispatches on:
 * - 'json': the default; validated input/query in, validated JSON out.
 * - 'form': multipart/form-data in ({@link MultipartInput}); validated fields, buffered files.
 * - 'raw': the handler owns the whole exchange and returns a `Response` (uploads beyond the
 *   buffered form, webhooks verifying raw bytes, files, 304s via `conditional`).
 * - 'stream': a Server-Sent-Events route; the handler drives the connection.
 *
 * The kinds beyond 'json' exist so those routes stay INSIDE the system: they inherit the
 * feature's guard and appear in the manifest and the OpenAPI document, instead of degrading to
 * hand-mounted `app.get` calls that re-implement authorization and vanish from the spec.
 */
export type RouteKind = 'json' | 'form' | 'raw' | 'stream';

/**
 * Display-only documentation for one route. NOTHING here affects registration, validation,
 * or the client - by contract, not just by convention: the OpenAPI exporter is the only
 * consumer. What a machine can derive (operation ids from feature keys, parameters from the
 * pattern, schemas from the declarations) is never repeated here; `docs` carries only
 * what a machine cannot know.
 */
export interface RouteDocs
{
    /** One-line summary shown beside the operation. */
    summary?: string;

    /** Longer prose (CommonMark). */
    description?: string;

    /** Grouping tags; defaults to the route's feature key in the registered record. */
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

/**
 * One uploaded file as a form-route handler receives it. Structurally identical to
 * @azerothjs/http's UploadedFile (register passes those through verbatim); declared here so
 * shared code - which browsers import - stays a pure schema+api affair.
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

/** What a form route's handler receives as `input`: validated text fields plus the files. */
export interface MultipartInput<Fields = Record<string, string>>
{
    /** The text fields - validated by the `fields` schema, or the raw first-value map without one. */
    fields: Fields;

    /** File parts in posted order. */
    files: ContractFile[];
}

/** @internal The brand distinguishing a typed status reply from an arbitrary object body. */
export const REPLY: unique symbol = Symbol('azerothjs.api.reply');

/**
 * A typed non-default reply: status + body + headers, built with {@link reply}. Unlike a
 * raw `Response`, the body is STILL validated against the route's schema for that status
 * (`responses[status]`, or `output` for 200) - a status code and headers do not cost
 * the route its output guarantee.
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
 * @internal A `responses` key as its numeric status. Reverse-mapped inference records the
 * literal keys of `{ 404: problem }` as the STRING `"404"` - a plain `& number` on the
 * keyof would erase every status, so this converts instead.
 */
type StatusOf<K> = K extends number ? K : K extends `${ infer N extends number }` ? N : never;

/**
 * The reply union a route's `responses` map admits: one {@link StatusReply} per declared
 * status with that status's body type, plus `StatusReply<200, Out>` when `output` is
 * declared, plus the always-legal bodyless reply (a 204/205/redirect carries nothing to
 * validate).
 */
export type ReplyOf<Out, Responses> =
    | (Responses extends Record<PropertyKey, unknown>
        ? { [S in keyof Responses]: StatusReply<StatusOf<S>, Responses[S]> }[keyof Responses]
        : never)
    | StatusReply<200, Out>
    | StatusReply<number, undefined>;

/**
 * THE context a route handler receives - the single argument, exactly like a plain
 * http handler, with the validated `input`/`query` added where the route declared a
 * schema. Whatever the guard chain attaches lands FLAT on this same object, TYPED - the
 * feature threads its guards' additions in, so a guarded handler reads them with no cast.
 * The documented parameter name is `context`.
 */
export interface HandlerContext<Path extends string, In, Query>
{
    /** The raw web-standard Request: headers, cookies, body, signal. */
    request: Request;

    /** The parsed request URL. */
    url: URL;

    /**
     * The path the router matched, percent-decoded per segment. Present so a handler can hand
     * its context to a helper typed against the kernel's RequestContext - at runtime it IS the
     * same object, and a type that hid this field forced a cast for no reason.
     */
    path: string;

    /** Decoded path parameters, typed from the pattern. */
    params: PathParams<Path> & Record<string, string>;

    /** The validated input body (undefined when the route declares no input schema). */
    input: In;

    /** The validated query object (undefined when the route declares no query schema). */
    query: Query;
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
     * The path the router matched, percent-decoded per segment. A guard is exactly the place this
     * matters: deciding on `url.pathname` lets `/%61dmin` read as a different path than the one
     * whose handler is about to run. (`//admin` cannot: the router refuses an empty segment
     * outright, so no such request reaches a guard.)
     */
    path: string;
}

/**
 * A guard: reads the context and returns an object to ADD to it (typed - the additions flow into
 * every handler behind it), a Response to short-circuit, or nothing.
 *
 * Any plain `(context) => void | Response` is a guard: {@link guard} (feature.ts) is only needed
 * when the guard ADDS to the context and that addition has to be inferred.
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
 * @internal The variance-erased guard a stored chain carries: any {@link Guard} or
 * {@link ExactGuard} is assignable BECAUSE the return is `unknown` - a `Guard<never>` would
 * reject every guard that actually adds something.
 */
export type AnyGuard = (context: GuardContext) => unknown;

/**
 * The wire-relevant declaration of one route: what the SPEC half of a builder call recorded.
 * Erased at the value level (register and the OpenAPI exporter read these fields); the TYPE
 * half rides on {@link Decl}'s generics.
 */
export interface SpecShape
{
    input?: RouteSchema<unknown>;
    query?: RouteSchema<unknown>;
    output?: RouteSchema<unknown>;
    responses?: Record<number, RouteSchema<unknown>>;
    docs?: RouteDocs;

    /** 'form' kind: validates the TEXT fields (first value wins for repeated names). */
    fields?: RouteSchema<unknown>;

    /** 'form' kind: total body cap in bytes (default 8 MiB). */
    limit?: number;

    /** 'form' kind: maximum number of parts (default 256). */
    maxParts?: number;

    /** 'form' kind: per-file cap in bytes (default: the total limit). */
    maxFileSize?: number;

    /** 'raw' kind: the request media type the OpenAPI document describes (default octet-stream). */
    accepts?: string;

    /** 'stream' kind: the declared SSE event names, for the document only. */
    events?: readonly string[];
}

/**
 * One declared route: kind, method, feature-relative path, spec, guard chain, handler - the
 * WHOLE route, written once. Three consumers read the same declaration: `register` (server),
 * the manifest projection + `typeof` (client), and the OpenAPI exporter (describer).
 *
 * The `any`-heavy {@link AnyDecl} view exists for the same variance reason the old contract
 * documented: schemas are invariant, so a bare `Decl` with defaulted generics would reject
 * every declared route.
 */
export interface Decl<Path extends string = string, In = undefined, Out = unknown, Query = undefined, Add = Record<never, never>, Kind extends RouteKind = RouteKind>
{
    kind: Kind;

    /** Uppercase wire method. 'raw' routes may carry any method string. */
    method: string;

    /** Feature-relative pattern; {@link pathOf} is the ONE place a full path is composed. */
    path: Path;

    spec: SpecShape;

    /**
     * The COMPLETE guard chain for this route when present - `r.with(...)` replaces the
     * feature's chain rather than adding to it, so a route's guards are readable at the route.
     * Absent means "inherit the feature chain".
     */
    guards?: ReadonlyArray<AnyGuard>;

    /** The handler. Typed through the builder; erased here. */
    handler: (context: never) => unknown;

    /** @internal Phantom slots carrying the inferred wire types for ClientOf/register. */
    readonly types?: { in: In; out: Out; query: Query; add: Add };
}

/**
 * Any route regardless of its wire types - the shape membership checks compare against.
 * The `any`s are deliberate (variance-erasing existential; schemas are invariant).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance-erasing existential; see the doc comment
export type AnyDecl = Decl<any, any, any, any, any>;

/** A feature's routes: name -> declaration. The name is written exactly once. */
export type Routes = Record<string, AnyDecl>;

/**
 * A built feature: the prefix, the declarations, the feature-level guard chain, and the
 * manifest projection. `typeof` a feature is the client's whole type source.
 */
export interface Feature<Prefix extends string = string, R extends Routes = Routes>
{
    prefix: Prefix;
    routes: R;

    /** The feature-level guard chain every route inherits unless it declared its own. */
    guards: ReadonlyArray<AnyGuard>;

    /** Projects the runtime half a client needs: method + path (+ non-json kind marker). */
    manifest(): Record<string, ManifestEntry>;
}

/**
 * One manifest row: everything a typed client needs at RUNTIME. Two fields for a JSON route;
 * `kind` appears only on routes the JSON client must refuse (form/raw/stream), so the refusal
 * is loud at the call instead of a silently mis-encoded request.
 */
export interface ManifestEntry
{
    method: string;

    /** The full feature-prefixed path (registration prefix excluded - that is the baseUrl). */
    path: string;

    kind?: 'form' | 'raw' | 'stream';
}

/** The manifest for a whole registered record: feature key -> route key -> entry. */
export type Manifest = Record<string, Record<string, ManifestEntry>>;

/**
 * THE full-path composition - router registration, the manifest, and the OpenAPI exporter all
 * call this one function, so the trailing-slash rule (`feature('/orgs/:slug')` + `r.get('/')`)
 * cannot drift between them.
 */
export function pathOf(prefix: string, path: string, mount = ''): string
{
    return `${ mount }${ prefix }${ path }`.replace(/\/$/, '') || '/';
}

/**
 * @internal THE rule for which schema validates a given status: the `responses` map, with `output`
 * as the declared shorthand for its 200 entry. Two consumers must agree on it - register validates
 * a handler's return against it, and the OpenAPI exporter describes the same status from it.
 */
export function responseSchemaFor(decl: AnyDecl, status: number): unknown
{
    const declared = decl.spec.responses?.[status];
    return declared ?? (status === 200 ? decl.spec.output : undefined);
}
