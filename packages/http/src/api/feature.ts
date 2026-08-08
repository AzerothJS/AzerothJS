/**
 * MODULE: api/feature - the colocated route declaration
 *
 * ONE concept declares an API: `feature(prefix, guards, (routes) => ({ ... }))`. Everything a route
 * is - method, path, schemas, guard, handler, docs - is written once, in one place, and three
 * consumers read the same declaration: `register` (server), `manifest()` + `typeof` (client),
 * and the OpenAPI exporter (describer).
 *
 * The builder callback is not a style choice: a plain object literal of routes CANNOT infer a
 * feature guard's additions, because each route value is constructed before the feature exists.
 * The guard chain must be in scope when the route is declared, which is exactly what the
 * callback's `routes` builder provides - and what `routes.with(...)` re-scopes per route.
 *
 * This replaced a defineContract / implement / mountApi trio plus a guards map and an `only()`
 * escape hatch. Measured against that design building the same product: half the files, half
 * the imported symbols, the route name written once instead of three times, and the four route
 * kinds the contract could not express (upload, webhook, 304, SSE) first-class instead of
 * hand-mounted around it.
 */

import type { AnyDecl, AnyGuard, Decl, ExactGuard, Feature, Guard, GuardContext, HandlerContext, Manifest, ManifestEntry, MultipartInput, ReplyOf, RouteDocs, RouteKind, RouteSchema, Routes, SpecShape } from './declare.ts';
import { pathOf } from './declare.ts';

/**
 * @internal The guard shape a callback's return type PROVES. Nothing `undefined`/`void` on the
 * awaited return means every path attaches, which is an ExactGuard; otherwise the guard may
 * attach nothing and the plain Guard shape says so.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- detecting `void` IS the rule here: a callback with a bare return infers it
type GuardOf<R> = [Extract<Awaited<R>, undefined | void>] extends [never]
    ? ExactGuard<Exclude<Awaited<R>, Response>>
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- same: the union is what is being excluded
    : Guard<Exclude<Awaited<R>, Response | undefined | void>>;

/**
 * Declares a typed guard. `guard((context) => ({ accountId: 7 }))` returns an
 * `ExactGuard<{ accountId: number }>` whose additions the feature threads into every handler
 * it protects - no cast at the use site.
 *
 * A guard with a conditional `return;` - the everyday optional-session guard - returns a
 * `Guard<{ accountId: number }>` instead, and the feature types that addition OPTIONAL. That is
 * the runtime truth: on the anonymous path nothing was ever assigned onto the context, so a
 * handler reading `context.accountId` as a `number` there is reading `undefined` through a type
 * that swore otherwise. Narrowing at the handler is the fix, and this is what makes the
 * compiler ask for it.
 */
export function guard<R>(fn: (context: GuardContext) => R): GuardOf<R>
{
    return fn as GuardOf<R>;
}

/** @internal Turns a union into an intersection (the standard contravariant-inference trick). */
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

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
 * A guard chain's combined additions: the INTERSECTION of every guard's, because register
 * `Object.assign`s each guard's return onto the ONE context in turn, so two guards that both
 * add leave BOTH fields on it. The final `extends object` filter keeps INTERFACE-typed
 * additions (no implicit index signature) from being silently dropped.
 */
export type AdditionsOf<G> = G extends ReadonlyArray<unknown>
    ? (AsAdditions<UnionToIntersection<AddOfOne<G[number]>>> extends infer R
        ? (R extends object ? R : Record<never, never>)
        : Record<never, never>)
    : Record<never, never>;

/** @internal What a JSON/form handler may produce for a route's declared shapes. */
type HandlerResult<Out, Responses> =
    Out | ReplyOf<Out, Responses> | Response | Promise<Out | ReplyOf<Out, Responses> | Response>;

/** The spec half of a bodyless JSON verb (`GET`/`DELETE` carry no request body). */
export interface BodylessSpec<Out, Query, Responses extends Record<number, unknown>>
{
    query?: RouteSchema<Query>;
    output?: RouteSchema<Out>;
    responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
    docs?: RouteDocs;
}

/** As {@link BodylessSpec}, for the verbs that carry a request body. */
export interface BodySpec<In, Out, Query, Responses extends Record<number, unknown>> extends BodylessSpec<Out, Query, Responses>
{
    input?: RouteSchema<In>;
}

/**
 * The spec half of a server action: the input object carries everything, so there is no
 * `query` - and the path carries no params, which is what makes the client call directly
 * callable.
 */
export interface ActionSpec<In, Out, Responses extends Record<number, unknown>>
{
    input?: RouteSchema<In>;
    output?: RouteSchema<Out>;
    responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
    docs?: RouteDocs;
}

/** The spec half of a `form` route: field validation plus the multipart caps. */
export interface FormSpec<Fields, Out, Responses extends Record<number, unknown>>
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

    output?: RouteSchema<Out>;
    responses?: { [S in keyof Responses]: RouteSchema<Responses[S]> };
    docs?: RouteDocs;
}

/** The spec half of a `raw` route: documentation only - the handler owns the exchange. */
export interface RawSpec
{
    /** The request media type the OpenAPI document describes (default application/octet-stream). */
    accepts?: string;
    docs?: RouteDocs;
}

/** The spec half of a `stream` (SSE) route: documentation only. */
export interface StreamSpec
{
    /** Declared event names, for the OpenAPI document. */
    events?: readonly string[];
    docs?: RouteDocs;
}

/**
 * The live connection a `stream` handler drives - structurally the kernel's SseConnection
 * (register passes it through verbatim), re-declared here so feature declarations stay
 * importable without the server entry.
 */
export interface StreamConnection
{
    /** Emits one event. Objects are JSON-stringified; multi-line strings frame correctly. */
    send(data: string | object, options?: { event?: string; id?: string; retryMs?: number }): void;

    /** Emits a `:` comment line (invisible to consumers). */
    comment(text: string): void;

    /** Ends the stream. */
    close(): void;

    /** Fires when the connection ends - client disconnect or close(). The teardown hook. */
    readonly signal: AbortSignal;

    /** The client's Last-Event-ID header, for resuming after a reconnect. */
    readonly lastEventId: string | null;
}

/**
 * The route builder a feature callback receives. Each verb takes `(path, spec, handler)` and
 * returns the full declaration; `Add` is the guard chain's typed additions, already on the
 * handler's context. `method`/`raw`/`stream`/`form` cover what a JSON verb cannot say, and
 * {@link Verbs.with} re-scopes the chain for a single declaration.
 */
export interface Verbs<Add, Prefix extends string>
{
    /** `routes.get('/users/:id', { output }, handler)` - GET carries no request body. */
    get<P extends string, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodylessSpec<Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, undefined, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, undefined, Out, Query, Add, 'json'>;

    /** `routes.post('/users', { input, output }, handler)`. */
    post<P extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodySpec<In, Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, Query, Add, 'json'>;

    /** `routes.put('/users/:id', { input, output }, handler)`. */
    put<P extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodySpec<In, Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, Query, Add, 'json'>;

    /** `routes.patch('/account', { input, output }, handler)`. */
    patch<P extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodySpec<In, Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, Query, Add, 'json'>;

    /** `routes.del('/users/:id', {}, handler)` - `del`, not `delete` (a reserved word as a method name is fine, but the SHORT verb set stays consistent with the app's route sugar). */
    del<P extends string, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodylessSpec<Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, undefined, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, undefined, Out, Query, Add, 'json'>;

    /**
     * `routes.query('/search', { input, output }, handler)` - a QUERY route (RFC 10008); `input` is
     * the query document, validated exactly as a POST body is. The handler MUST NOT mutate state.
     *
     * @experimental QUERY is not yet deployed internet reality - proxies, caches, and tooling
     * may not recognize it.
     */
    query<P extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: BodySpec<In, Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, Query, Add, 'json'>;

    /**
     * A JSON route whose method is not a literal - assembling routes from configuration. The
     * body-ness is unknowable, so the spec is permissive; prefer the named verbs.
     */
    method<P extends string, In = undefined, Out = unknown, Query = undefined, Responses extends Record<number, unknown> = Record<never, never>>(
        method: string, path: P, spec: BodySpec<In, Out, Query, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, Query> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, Query, Add, 'json'>;

    /**
     * `routes.action('/create', { input, output }, handler)` - a server action. POST-only
     * and PARAM-FREE (the input object carries everything), so the typed client surfaces it
     * as a directly-callable function: `client.posts.create(input)`. Wire behavior is
     * exactly a JSON POST: input validated (422 field map), output contract-checked,
     * guards composing through the ordinary chain - pair with `csrfProtect` for
     * browser-facing mutations.
     */
    action<P extends string, In = undefined, Out = unknown, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: ActionSpec<In, Out, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, In, undefined> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, In, Out, undefined, Add, 'action'>;

    /**
     * `routes.form('/files', { fields, maxFileSize }, handler)` - the multipart/form-data route.
     * The handler's `input` is `{ fields, files }`: fields validated against the schema (422 on
     * failure, the same field map as JSON routes), files buffered within the caps. A
     * non-multipart POST is a 415. Beyond-memory uploads keep using `streamMultipart` in an
     * `routes.raw` handler - the buffered form is for form-with-files scale, not media ingest. The
     * typed client refuses these routes (a browser posts FormData directly).
     */
    form<P extends string, Fields = Record<string, string>, Out = unknown, Responses extends Record<number, unknown> = Record<never, never>>(
        path: P, spec: FormSpec<Fields, Out, Responses>,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, MultipartInput<Fields>, undefined> & Add) => HandlerResult<Out, Responses>
    ): Decl<P, MultipartInput<Fields>, Out, undefined, Add, 'form'>;

    /**
     * `routes.raw('POST', '/webhooks/stripe', {}, handler)` - the handler owns the whole exchange
     * and returns a `Response`. This is how uploads beyond the buffered form, webhooks that
     * verify raw bytes, file downloads, and `conditional()` 304 routes stay INSIDE the
     * feature: they inherit its guard and appear in the manifest and the OpenAPI document.
     */
    raw<P extends string>(
        method: string, path: P, spec: RawSpec,
        handler: (context: HandlerContext<`${ Prefix }${ P }`, undefined, undefined> & Add) => Response | Promise<Response>
    ): Decl<P, undefined, Response, undefined, Add, 'raw'>;

    /**
     * `routes.stream('/events', {}, open)` - a Server-Sent-Events route. `open` receives the guarded
     * context and the live connection; an unauthenticated request is refused by the SAME guard
     * chain the JSON routes use.
     */
    stream<P extends string>(
        path: P, spec: StreamSpec,
        open: (context: HandlerContext<`${ Prefix }${ P }`, undefined, undefined> & Add, connection: StreamConnection) => void | Promise<void>
    ): Decl<P, undefined, Response, undefined, Add, 'stream'>;

    /**
     * ADDS guards to the chain for the declarations made through the RETURNED builder -
     * the feature's chain still runs, then these, in order. Chains:
     * `routes.with(throttle).with(audit)` runs the feature chain, then throttle, then
     * audit - the same accumulating semantics as the kernel's `app.with`.
     *
     * A route can only ever gain protection this way. To LOSE the feature's chain, say
     * so with {@link Verbs.only}.
     */
    with<const G extends ReadonlyArray<AnyGuard>>(...guards: G): Verbs<Add & AdditionsOf<G>, Prefix>;

    /**
     * REPLACES the chain for the declarations made through the RETURNED builder: the
     * feature's guards do not run, only these. `routes.only()` with no arguments is the
     * deliberate unguarded opt-out - a sign-in route inside a guarded feature IS the way
     * in, and it is visible and greppable at the route.
     *
     * Dropping an inherited guard is the one thing here that can turn a protected route
     * into an open one, so it has its own name: `grep -rn 'routes.only'` is the complete
     * inventory of every place a feature's protection stops.
     */
    only<const G extends ReadonlyArray<AnyGuard>>(...guards: G): Verbs<AdditionsOf<G>, Prefix>;
}

/**
 * @internal Builds one verbs surface. `inherited` is the feature's chain and `scoped` the
 * guards added by `with()` at this point; `only()` returns a surface with an EMPTY
 * inherited chain, which is the whole of what replacement means. Every declaration is
 * stamped with its COMPLETE chain here, where both halves are known - so there is no
 * later moment at which a route's real guards have to be inferred.
 */
function verbs(inherited: ReadonlyArray<AnyGuard>, scoped: ReadonlyArray<AnyGuard>): Verbs<Record<never, never>, string>
{
    const chain = scoped.length === 0 ? inherited : [...inherited, ...scoped];

    const decl = (kind: RouteKind, method: string, path: string, spec: SpecShape, handler: (context: never) => unknown): AnyDecl =>
        ({ kind, method, path, spec, handler, guards: chain });

    // The type-erased factory behind every verb; the Verbs interface's generics re-clothe it.
    const make = (kind: RouteKind, method: string) =>
        (path: string, spec: unknown, handler: unknown): AnyDecl =>
            decl(kind, method, path, spec as SpecShape, handler as (context: never) => unknown);

    return {
        get: make('json', 'GET'),
        post: make('json', 'POST'),
        put: make('json', 'PUT'),
        patch: make('json', 'PATCH'),
        del: make('json', 'DELETE'),
        query: make('json', 'QUERY'),
        method: (method: string, path: string, spec: unknown, handler: unknown): AnyDecl =>
            make('json', method.toUpperCase())(path, spec, handler),
        action: (path: string, spec: unknown, handler: unknown): AnyDecl =>
        {
            if (path.includes(':') || path.includes('*'))
            {
                throw new Error(`routes.action("${ path }"): an action path cannot carry params - `
                    + 'the input object is the whole argument; move the value into the input schema.');
            }
            return make('action', 'POST')(path, spec, handler);
        },
        form: make('form', 'POST'),
        raw: (method: string, path: string, spec: unknown, handler: unknown): AnyDecl =>
            make('raw', method.toUpperCase())(path, spec, handler),
        stream: make('stream', 'GET'),
        with: (...guards: ReadonlyArray<AnyGuard>) => verbs(inherited, [...scoped, ...guards]),
        only: (...guards: ReadonlyArray<AnyGuard>) => verbs([], guards)
    } as unknown as Verbs<Record<never, never>, string>;
}

/**
 * Declares a feature: a prefix, an optional guard chain, and the routes built through the
 * callback's {@link Verbs}. The chain's typed additions are already on every handler's context;
 * `routes.with(...)` ADDS guards to it for one route and `routes.only(...)` replaces it. The
 * route name is written exactly once - it keys the object, the manifest, the client surface,
 * and the OpenAPI operation.
 *
 * ```ts
 * export const keys = feature('/keys', [requireAuth], (routes) => ({
 *     list:   routes.get('/', { output: keyList }, (context) => listKeys(context.accountId)),
 *     create: routes.post('/', { input: keyInput, output: keyRecord }, (context) => mint(context)),
 *     revoke: routes.del('/:keyId', {}, (context) => revoke(context.params.keyId))
 * }));
 * ```
 */
export function feature<Prefix extends string, R extends Routes>(
    prefix: Prefix,
    build: (routes: Verbs<Record<never, never>, Prefix>) => R
): Feature<Prefix, R>;
export function feature<Prefix extends string, const G extends ReadonlyArray<AnyGuard>, R extends Routes>(
    prefix: Prefix,
    guards: G,
    build: (routes: Verbs<AdditionsOf<G>, Prefix>) => R
): Feature<Prefix, R>;
export function feature(
    prefix: string,
    guardsOrBuild: ReadonlyArray<AnyGuard> | ((routes: Verbs<Record<never, never>, string>) => Routes),
    maybeBuild?: (routes: Verbs<Record<never, never>, string>) => Routes
): Feature
{
    const chain = typeof guardsOrBuild === 'function' ? [] : guardsOrBuild;
    const build = typeof guardsOrBuild === 'function' ? guardsOrBuild : maybeBuild as (routes: Verbs<Record<never, never>, string>) => Routes;
    // The builder is handed the feature chain, so each declaration resolves its own
    // complete chain as it is written - inheritance is never left to be re-derived.
    const routes = build(verbs(chain, []));

    return {
        prefix,
        routes,
        manifest(): Record<string, ManifestEntry>
        {
            const out: Record<string, ManifestEntry> = {};
            for (const [name, declaration] of Object.entries(routes))
            {
                const entry: ManifestEntry = { method: declaration.method, path: pathOf(prefix, declaration.path as string) };
                if (declaration.kind !== 'json')
                {
                    entry.kind = declaration.kind;
                }
                out[name] = entry;
            }
            return out;
        }
    };
}

/**
 * Projects the manifest for a whole record of features - the JSON-safe value a client is built
 * from (`createClient(manifest, ...)` plus `typeof` the features for the types). Serialize it at
 * build time, serve it, or import it through a build-level module - it contains methods and
 * paths only: no schemas, no handlers, no functions.
 */
export function manifestOf(features: Record<string, Feature>): Manifest
{
    const out: Manifest = {};
    for (const [key, built] of Object.entries(features))
    {
        out[key] = built.manifest();
    }
    return out;
}
