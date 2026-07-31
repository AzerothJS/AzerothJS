/**
 * MODULE: http/app - the kernel dispatcher
 *
 * The smallest complete server: register routes, then `handle(request)` maps any web-standard
 * Request to exactly one Response. Everything the architecture promises about the hot path is
 * enforced here:
 *
 *   - `handle` NEVER throws and never returns a rejected promise. Every failure - a handler
 *     throw, an async rejection, a body-reader error - flows through the one error path
 *     (errors.ts) and comes back as a Response. There is no crashed process and no hung
 *     request, the two classic Express failure modes.
 *   - A miss is a 404; a path that exists under other methods is a 405 WITH the Allow header
 *     (the router distinguishes them by construction).
 *   - HEAD is served from the GET handler with the body stripped and the entity headers kept,
 *     per RFC 9110 - and a streaming body is cancelled, not leaked.
 *   - The handler context is TYPED from the route pattern: `app.get('/users/:id', ...)`
 *     receives `context.params: { id: string }` with no annotation, no codegen, no cast.
 *
 * `app.handle(new Request('http://local/x'))` is the entire integration-testing story - no
 * sockets, no listen(), no inject shim. Middleware compose ABOVE this dispatcher via typed
 * context accumulation (see `use`); every dispatch runs inside a request root (store
 * isolation + cleanup registry; see request-root.ts); adapters (node:http etc.) sit below.
 */

import type { PathParams } from './router.ts';
import { RadixRouter, segmentsOf } from './router.ts';
import { BadRequestError, HttpError, MethodNotAllowedError, NotFoundError, errorResponse, notFoundResponse, type ErrorObserver, type ErrorSerializer } from './errors.ts';
import { runInRequestRoot } from './request-root.ts';
import { isEdge, type EdgeMiddleware, type HandlerWrapper, type WebHandler } from './edge.ts';

/**
 * THE context - the single argument every handler receives, carrying this one
 * request's whole world: the raw web-standard Request, the typed path params, the
 * parsed URL, and (flat on the object) whatever middleware added. The documented
 * parameter name is `context`; the framework only defines the shape.
 */
export interface RequestContext<Params extends Record<string, string> = Record<string, string>>
{
    /** The raw web-standard Request: headers, cookies, body, signal. */
    request: Request;

    /** Decoded path parameters, typed from the route pattern. */
    params: Params;

    /** The parsed request URL (parsed lazily, once, shared by everyone). */
    url: URL;

    /**
     * The path the ROUTER matched: percent-decoded per segment, one trailing slash dropped.
     * Prefer THIS over `url.pathname` for a policy decision (an auth prefix check, a CSRF
     * exemption list, a rate-limit bucket, an audit line), because `url.pathname` preserves the
     * client's spelling: `/%61dmin` reads as something other than `/admin` there while still
     * reaching the `/admin` handler.
     *
     * A path carrying an empty segment (`//admin`) no longer reaches any handler at all - it is
     * a distinct URI and the router refuses it - so that spelling is not a way around a check
     * written on either accessor.
     */
    path: string;
}

/** A route handler: one context in, exactly one Response out. Ctx is what middleware added. */
export type Handler<Params extends Record<string, string> = Record<string, string>, Ctx extends object = object> =
    (context: RequestContext<Params> & Ctx) => Response | Promise<Response>;

/**
 * The observability seam: called once per request with the outcome and wall time. This is
 * where request logging, metrics, and tracing attach (an OpenTelemetry span is one observer
 * away) - interfaces live here, dependencies do not. Observer throws are swallowed: watching
 * the system must never be able to break it.
 */
export interface RequestObserver
{
    onComplete(request: Request, response: Response, durationMs: number): void;
}

/**
 * One app's policy: what an error reveals, who watches a request, and whether each dispatch
 * gets a request root. Decided once at construction - a {@link App.with} fork shares it.
 */
export interface AppOptions
{
    /**
     * Development mode: error responses expose non-HttpError messages and 5xx stacks.
     * Never enable in production - secrecy of internals is the default for a reason.
     */
    dev?: boolean | undefined;

    /** Observes every error the app maps (logging seam). Its own throws are swallowed. */
    onError?: ErrorObserver;

    /**
     * Reshapes the error wire body so the app can speak its own envelope instead of the default
     * `{ error: { code, message } }` - return a plain value to replace the body, a `Response` for
     * full control, or `undefined` to keep the default for that error. Applies uniformly to every
     * error, route-miss 404s included; a broken serializer falls back to the default shape.
     */
    serializeError?: ErrorSerializer;

    /**
     * Wrap every dispatch in a request root (store isolation across awaits + the
     * onRequestCleanup registry). Default true; set false only where the runtime lacks
     * AsyncLocalStorage or for micro-benchmarking the bare kernel.
     */
    requestRoot?: boolean;

    /** Observes every completed request (logging/metrics/tracing seam). */
    observe?: RequestObserver | undefined;
}

/**
 * @internal Names the SHAPE of a handler's bad return value, never its contents - the text
 * reaches logs and a dev-mode error body, and the value can hold application data.
 */
function describeResult(value: unknown): string
{
    if (value === null)
    {
        return 'null';
    }
    if (Array.isArray(value))
    {
        return 'an array';
    }
    const type = typeof value;
    return type === 'object' ? 'a plain object' : type;
}

/**
 * @internal The pathname of an absolute-form URL by string scan - no URL allocation on the
 * hot path. The path starts at the first '/' after the authority and ends at '?' or '#'.
 */
export function pathnameOf(url: string): string
{
    const schemeEnd = url.indexOf('://');
    const pathStart = url.indexOf('/', schemeEnd === -1 ? 0 : schemeEnd + 3);
    if (pathStart === -1)
    {
        return '/';
    }
    let pathEnd = url.length;
    for (let i = pathStart; i < url.length; i++)
    {
        const ch = url.charCodeAt(i);
        if (ch === 63 || ch === 35) // '?' or '#'
        {
            pathEnd = i;
            break;
        }
    }
    return url.slice(pathStart, pathEnd);
}

/**
 * @internal Post-handler finishing. HEAD via the GET fallback: entity headers stay, the
 * body must not cross the wire - and a streaming body is cancelled so its producer stops
 * (dropping the reference would leak the stream's resources until GC). Everything else
 * passes through synchronously.
 */
function finishDispatch(request: Request, response: Response): Response | Promise<Response>
{
    if (request.method.toUpperCase() === 'HEAD' && response.body !== null)
    {
        return response.body.cancel().then(() =>
            new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }));
    }
    return response;
}

/**
 * @internal The context every handler receives. `url` is LAZY via a prototype getter:
 * routing needed only the pathname (a string scan), most handlers never touch the URL
 * object, and a prototype accessor keeps one object shape across every request - a
 * per-request accessor literal would defeat the JIT's shape caching.
 */
class DispatchContext implements RequestContext
{
    public readonly request: Request;

    public readonly params: Record<string, string>;

    #url: URL | null = null;

    #path: string | null = null;

    constructor(params: Record<string, string>, request: Request)
    {
        this.request = request;
        this.params = params;
    }

    public get url(): URL
    {
        this.#url ??= new URL(this.request.url);
        return this.#url;
    }

    public get path(): string
    {
        // The path the ROUTER matched: percent-decoded per segment, so `/%61dmin` reads as
        // `/admin` where `url.pathname` keeps the raw spelling. segmentsOf still collapses empty
        // segments here, which is harmless now that the router REFUSES a path containing one -
        // nothing carrying `//` reaches a handler for this getter to describe.
        if (this.#path === null)
        {
            const segments = segmentsOf(pathnameOf(this.request.url));
            const decoded: string[] = [];
            for (const segment of segments)
            {
                try
                {
                    decoded.push(decodeURIComponent(segment));
                }
                catch
                {
                    decoded.push(segment);
                }
            }
            this.#path = `/${ decoded.join('/') }`;
        }
        return this.#path;
    }
}

/**
 * A middleware: reads the context accumulated SO FAR (the request rides on it), and
 * returns either the context it ADDS (an object, merged flat onto the context for
 * everything downstream), a Response (short circuit: guards deny, caches answer
 * early), or nothing. There is no `next()` - control flow is the return value, and
 * the chain is composed once per route at registration.
 */
export type Middleware<Ctx extends object, Added extends Record<string, unknown>> =
    (context: RequestContext & Ctx) =>
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps bare-return/no-return observers assignable; null is accepted as "adds nothing" for JS callers
    Added | Response | null | undefined | void | Promise<Added | Response | null | undefined | void>;

/**
 * A named, versioned server plugin: the packaged form of the functional `app.register(fn)` seam.
 * `install` receives the app - with whatever context type it has accumulated so far - and
 * returns the (possibly more capable) app; the return TYPE flows the plugin's context additions
 * to everything registered after it, exactly as `use` and `plugin` do. `name` identifies the
 * plugin so a double registration is caught at boot rather than silently applied twice.
 *
 * A plugin does only what an ordinary caller could do by hand: register routes, add middleware
 * via `use`, mount an edge pipeline, read config. There is no privileged hook into the kernel
 * and none into the compiler - a plugin extends the running server, never the language.
 *
 * @example
 * ```ts
 * const timing: AzerothPlugin<object, { startedAt: number }> =
 * {
 *     name: 'timing',
 *     version: '1.0.0',
 *     install: (app) => app.use(() => ({ startedAt: Date.now() }))
 * };
 * app.register(timing); // ctx now carries startedAt for later routes
 * ```
 */
export interface AzerothPlugin<In extends object = object, Out extends object = In>
{
    /** Unique plugin name; a second registration under the same name throws at boot. */
    name: string;

    /** Optional semver of the plugin, surfaced by {@link App.plugins} for diagnostics. */
    version?: string | undefined;

    /** Applies the plugin to the app, returning the app with any context additions. */
    install(app: App<In>): App<Out>;
}

/**
 * @internal What a {@link App.with} fork inherits from its parent. The router is SHARED (every
 * route lands in one table), the options are SHARED (one error/observer policy), the plugin
 * registry is SHARED (a duplicate is caught across forks); only the middleware list is a COPY, so
 * a fork's added middleware never leaks back to the parent. Not part of the public surface.
 */
interface AppInternals
{
    router: RadixRouter<Handler>;
    middlewares: Array<Middleware<object, Record<string, unknown>>>;
    installed: Array<{ name: string; version?: string | undefined }>;
    wrappers: HandlerWrapper[];
}

/**
 * The application: one route table, the middleware stacked above it, and {@link handle} below.
 *
 * `new App().get('/x', handler)` is already a complete server - no plugin, no adapter, and no
 * socket is required to exercise it. Registration is LEXICAL: {@link use} applies to every route
 * registered after it, {@link with} only to the routes registered through the view it returns,
 * and each route snapshots its chain at registration, so nothing added later reaches back into a
 * route already on the table.
 *
 * `Ctx` is what middleware and plugins have added to the handler context, accumulated by the type
 * system as they are registered: it starts empty, every {@link use} / {@link with} /
 * {@link register} widens it, and a handler therefore reads `context.accountId` with no cast -
 * while one registered ABOVE the middleware that supplies it fails to compile.
 *
 * There are no sub-applications: {@link with} and {@link register} return views onto the SAME
 * table, so a request is matched once, no mount prefix has to be composed by hand, and
 * {@link routes} prints the entire surface.
 *
 * @example
 * ```ts
 * const app = new App({ dev: process.env.NODE_ENV !== 'production' });
 *
 * app.get('/healthz', () => json({ ok: true }));
 * app.with(requireAuth).get('/account/me', (context) => json({ id: context.accountId }));
 *
 * const response = await app.handle(new Request('http://local/healthz')); // the whole test story
 * ```
 */
export class App<Ctx extends object = object>
{
    readonly #router: RadixRouter<Handler>;

    readonly #options: AppOptions;

    /** The middleware registered so far; each route snapshots this list when registered. */
    readonly #middlewares: Array<Middleware<object, Record<string, unknown>>>;

    /** Installed named plugins, in registration order (introspected via {@link plugins}). */
    readonly #installed: Array<{ name: string; version?: string | undefined }>;

    /**
     * Edge wrappers applied around dispatch, innermost first (see {@link wrap}). Shared with a
     * {@link with} fork by reference, so wrapping through a fork wraps the app it forked from -
     * an edge concern is per-SERVER, never per-route.
     */
    readonly #wrappers: HandlerWrapper[];

    /** @internal The wrapped dispatch, rebuilt whenever {@link wrap} adds a layer. */
    #wrapped: WebHandler | null = null;

    /**
     * @param options Error, observability, and request-root policy for every route on this app.
     * @param internals @internal What a {@link with} fork inherits; never passed by application code.
     */
    constructor(options: AppOptions = {}, internals?: AppInternals)
    {
        this.#options = options;
        this.#router = internals?.router ?? new RadixRouter<Handler>();
        this.#middlewares = internals?.middlewares ?? [];
        this.#installed = internals?.installed ?? [];
        this.#wrappers = internals?.wrappers ?? [];
    }

    /**
     * Appends a middleware. Its returned object joins the context TYPE for every route
     * registered AFTER it - ordering is lexical: what you read top-to-bottom is what runs,
     * and a route above a `use` is untouched by it. The runtime merge happens in the
     * composed chain; middleware never mutate the context directly, they return additions.
     *
     * Also takes an EDGE middleware ({@link rateLimit}, {@link cors}, {@link securityHeaders},
     * {@link requestId}, or your own via `edge()`), which wraps the whole dispatch instead of
     * joining the per-route chain - it has to, because a limiter must refuse before a route is
     * matched and a preflight must be answered for paths with no route. The two kinds are told
     * apart by a brand, not by shape, because both are single-argument functions.
     *
     * SOUNDNESS CAVEATS (the deliberate trade, same one Hono makes): `use` mutates the
     * shared middleware list and returns `this` re-typed, so (1) an app reference ALIASED
     * before the `use` registers routes whose handlers run the middleware but are typed
     * WITHOUT its additions, and (2) a middleware that can SHORT-CIRCUIT (return a
     * Response instead of additions) leaves the additions typed-as-present on paths it
     * never decorated. When either matters, prefer {@link with}: its forked view makes
     * both the scope and the typing exact.
     *
     * The reverse trade is real too, so this is a choice and not a ranking: `with` RETURNS the
     * app that carries the middleware and does not mutate this one, so dropping its return value
     * is a silent no-op - `app.with(requireAuth)` on its own compiles, runs, and leaves the routes
     * below it unguarded. `use` cannot fail that way. Reach for `with` when scope or exact typing
     * matters; reach for `use` when the middleware genuinely applies to everything after it.
     */
    public use(edgeMiddleware: EdgeMiddleware): this;
    public use<Added extends Record<string, unknown> = Record<never, never>>(
        middleware: Middleware<Ctx, Added>
    ): App<Ctx & Added>;
    public use<Added extends Record<string, unknown> = Record<never, never>>(
        middleware: Middleware<Ctx, Added> | EdgeMiddleware
    ): App<Ctx & Added>
    {
        // An EDGE middleware wraps dispatch instead of joining the per-route chain. It is
        // recognised by its brand rather than its shape, because both kinds are single-argument
        // functions and an overload resolved by types alone would silently mis-route a
        // JavaScript caller.
        if (isEdge(middleware))
        {
            this.#wrappers.push(middleware);
            this.#wrapped = null;
            return this as unknown as App<Ctx & Added>;
        }

        this.#middlewares.push(middleware as Middleware<object, Record<string, unknown>>);
        return this as unknown as App<Ctx & Added>;
    }

    /**
     * Opens a SCOPED registration view. `app.with(mw)` returns an app that shares this one's route
     * table but runs `mw` only for the routes registered THROUGH the returned view - and no others.
     * It is the scoped counterpart to {@link use}: `use` makes a middleware global from its lexical
     * position onward, `with` confines it to a handful of routes without a manual guard call inside
     * each handler. Chain it - `app.with(throttle).with(requireAuth).get(...)` - and each middleware's
     * context additions flow into the next and into the handler, typed end to end. The fork never
     * mutates this app: routes registered directly on `app` are untouched, and a later `app.use` does
     * not reach back into an already-opened fork.
     *
     * @example
     * ```ts
     * const authed = app.with(requireAuth); // Middleware<Ctx, { accountId: number }>
     * authed.get('/account/me', (context) => json({ id: context.accountId })); // typed
     * authed.patch('/account', updateHandler);
     * app.get('/health', () => text('ok')); // no auth - the fork did not touch app
     * ```
     */
    public with<Added extends Record<string, unknown> = Record<never, never>>(
        middleware: Middleware<Ctx, Added>
    ): App<Ctx & Added>
    {
        return new App<Ctx & Added>(this.#options, {
            router: this.#router,
            middlewares: [...this.#middlewares, middleware as Middleware<object, Record<string, unknown>>],
            wrappers: this.#wrappers,
            installed: this.#installed
        });
    }

    /** Registers a handler; the pattern's params type the context. Conflicts throw here, at boot. */
    public route<P extends string>(method: string, pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        // Compose ONCE at registration: routes registered before any middleware stay bare
        // (the kernel hot path is untouched), and each route runs exactly the chain that was
        // lexically above it.
        if (this.#middlewares.length === 0)
        {
            this.#router.insert(method, pattern, handler as Handler);
            return this;
        }
        const chain = this.#middlewares.slice();
        // The chain stays SYNCHRONOUS while middlewares return plain values - awaiting a
        // non-promise still costs a microtask hop per middleware per request, which is pure
        // overhead for the common sync guard/context middleware. The first thenable result
        // switches that request onto the promise path; semantics are identical.
        const applyResult = (ctx: object, result: unknown): Response | null =>
        {
            if (result instanceof Response)
            {
                return result;
            }
            if (result !== undefined && result !== null)
            {
                // `request`, `params` and `url` are readonly to TypeScript and writable at
                // runtime, so a middleware that returns parsed request data as its additions
                // (`app.use((c) => readJson(c.request))`) would let a body of
                // `{"params":{"id":"admin"}}` replace the path params a handler authorises on.
                // Own keys only: an addition must never arrive from a polluted prototype.
                for (const key of Object.keys(result))
                {
                    if (key !== 'request' && key !== 'params' && key !== 'url')
                    {
                        (ctx as Record<string, unknown>)[key] = (result as Record<string, unknown>)[key];
                    }
                }
            }
            return null;
        };
        const composed: Handler = (context) =>
        {
            const step = (index: number): ReturnType<Handler> =>
            {
                for (let i = index; i < chain.length; i++)
                {
                    const middleware = chain[i];
                    if (middleware === undefined)
                    {
                        continue;
                    }
                    const result = middleware(context);
                    if (result instanceof Promise)
                    {
                        const after = i + 1;
                        return result.then((resolved) => applyResult(context, resolved) ?? step(after));
                    }
                    const short = applyResult(context, result);
                    if (short !== null)
                    {
                        return short;
                    }
                }
                return (handler as Handler)(context);
            };
            return step(0);
        };
        this.#router.insert(method, pattern, composed);
        return this;
    }

    /**
     * Registers a GET route. HEAD on the same pattern is answered from this handler with the body
     * stripped and the entity headers kept, so a HEAD route is never written by hand.
     *
     * @example
     * ```ts
     * app.get('/users/:id', (context) => json({ id: context.params.id })); // params typed from the pattern
     * ```
     */
    public get<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('GET', pattern, handler);
    }

    /** Registers a POST route: the write that is NOT idempotent - a creation, or an action. */
    public post<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('POST', pattern, handler);
    }

    /** Registers a PUT route: a whole-resource write, sent twice for the same end state. */
    public put<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('PUT', pattern, handler);
    }

    /** Registers a PATCH route: a partial update, the body carrying only what changes. */
    public patch<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('PATCH', pattern, handler);
    }

    /** Registers a DELETE route. The name is `delete`, not `del`: it is a method, not a bare word. */
    public delete<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('DELETE', pattern, handler);
    }

    /**
     * Registers a QUERY handler (RFC 10008). QUERY is a SAFE and IDEMPOTENT method that carries
     * a request body: it is for reads whose parameters are too large or too structured for a URL
     * (a complex filter, a search document), where a GET query string does not fit and a POST
     * would wrongly signal a state change. The handler MUST NOT mutate state - that contract is
     * what lets responses be cached and requests retried. Read the body as you would a POST's
     * (readJson/readForm enforce the required Content-Type); reply with `queryResult`.
     * @experimental The QUERY method (RFC 10008) is not yet deployed internet reality -
     * proxies, caches, and tooling may not recognize it. The surface is stable within the
     * 1.x train but carries an experimental flag until the RFC is.
     */
    public query<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('QUERY', pattern, handler);
    }

    /**
     * Registers a plugin - the ONE plugin verb, in either form:
     *
     *   - a NAMED plugin ({@link AzerothPlugin}): runs `install`, records name+version, and
     *     REJECTS a second registration under the same name (a duplicate is almost always a
     *     wiring mistake - two copies, or two versions - and applying it twice would double
     *     its middleware/routes). The shipped-module form.
     *   - a plain FUNCTION over the app returning the (possibly more capable) app: applied
     *     directly, no registry entry - the one-off anonymous transform.
     *     `app.register(auth).register(metrics)` IS the composition, typed end to end.
     *
     * Either way the plugin's context additions flow into the returned app's type, so
     * routes registered afterwards see them.
     */
    public register<Out extends object>(plugin: AzerothPlugin<Ctx, Out>): App<Out>;
    // eslint-disable-next-line @typescript-eslint/unified-signatures -- a union parameter defeats Out inference for the bare-function form; separate overloads keep both forms fully inferred
    public register<Out extends object>(fn: (app: App<Ctx>) => App<Out>): App<Out>;
    public register<Out extends object>(plugin: AzerothPlugin<Ctx, Out> | ((app: App<Ctx>) => App<Out>)): App<Out>
    {
        if (typeof plugin === 'function')
        {
            return plugin(this);
        }
        if (this.#installed.some((entry) => entry.name === plugin.name))
        {
            throw new Error(`Plugin '${ plugin.name }' is already registered.`);
        }
        const next = plugin.install(this);
        // The registry lives on the returned app instance; install() returns `this` re-typed
        // (use/route/query all mutate and return the same object), so the record is shared.
        (next as unknown as App<Ctx>).#installed.push({ name: plugin.name, version: plugin.version });
        return next;
    }

    /** The installed plugins (name + version), in registration order - print it at boot. */
    public plugins(): ReadonlyArray<{ name: string; version?: string | undefined }>
    {
        return this.#installed;
    }

    /** The registered route table, one line per route - print it at boot. */
    public routes(): string[]
    {
        return this.#router.table();
    }

    /**
     * Maps one Request to one Response. This function cannot throw and cannot reject; every
     * failure becomes an error Response through the one error path. Unless opted out, the
     * whole dispatch runs inside a request root: stores are request-isolated across awaits
     * and onRequestCleanup teardown ALWAYS runs when the request settles.
     */
    public async handle(request: Request): Promise<Response>
    {
        const observer = this.#options.observe;
        const started = observer !== undefined ? performance.now() : 0;
        let response: Response;
        try
        {
            // Edge wrappers (see `wrap`) sit OUTSIDE routing and the request root: a rate limiter
            // must refuse before a route is matched, and a preflight must be answered for paths
            // that have no route. Composed lazily and cached; `wrap` invalidates.
            if (this.#wrappers.length > 0)
            {
                // reduceRight, so the FIRST registered wrapper is outermost - the same order
                // `pipeline(app, cors, rateLimit)` composes in. Reducing left-to-right would make
                // the last `use` outermost, giving the framework two opposite orders for one
                // concept and making a security header's position depend on which API applied it.
                this.#wrapped ??= this.#wrappers.reduceRight<WebHandler>(
                    (next, wrapper) => wrapper(next),
                    { handle: (inner: Request): Promise<Response> => this.#dispatchOnly(inner) }
                );
                response = await this.#wrapped.handle(request);
            }
            else if (this.#options.requestRoot === false)
            {
                response = await this.#dispatch(request);
            }
            else
            {
                // One stable dispatch reference and one stable options object for the app's
                // lifetime - the per-request closure and options allocation were pure garbage.
                this.#rootOptions ??= {
                    onCleanupError: ((): ((error: unknown) => void) | undefined =>
                    {
                        const onError = this.#options.onError;
                        return onError !== undefined
                            ? (error): void =>
                            {
                                onError(error, new HttpError(500, 'Request cleanup failed', { cause: error }));
                            }
                            : undefined;
                    })()
                };
                response = await runInRequestRoot(this.#dispatchBound, request, this.#rootOptions);
            }

            // A handler that RESOLVES with a non-Response is the one way a failure used to
            // escape this contract: nothing threw, so the error path never ran, the observer
            // recorded a success, and the value went back to a caller that expected a Response.
            // An async handler missing a `return` on one branch is the common way in.
            if (!(response instanceof Response))
            {
                throw new HttpError(500, `Handler for ${ request.method } ${ pathnameOf(request.url) } returned ${ describeResult(response) } instead of a Response.`, { code: 'invalid-handler-result' });
            }
        }
        catch (error)
        {
            response = errorResponse(error, {
                dev: this.#options.dev,
                observe: this.#options.onError,
                serialize: this.#options.serializeError,
                request
            });
        }
        if (observer !== undefined)
        {
            try
            {
                observer.onComplete(request, response, performance.now() - started);
            }
            catch
            {
                // Watching the system must never be able to break it.
            }
        }
        return response;
    }

    /**
     * @internal Dispatch with the request-root policy applied, but WITHOUT the observer or the
     * error path - both belong to {@link handle}, which owns them for wrapped and unwrapped
     * requests alike. Only the edge-wrapper chain calls this.
     */
    async #dispatchOnly(request: Request): Promise<Response>
    {
        if (this.#options.requestRoot === false)
        {
            return await this.#dispatch(request);
        }
        this.#rootOptions ??= {
            onCleanupError: ((): ((error: unknown) => void) | undefined =>
            {
                const onError = this.#options.onError;
                return onError !== undefined
                    ? (error): void =>
                    {
                        onError(error, new HttpError(500, 'Request cleanup failed', { cause: error }));
                    }
                    : undefined;
            })()
        };
        return await runInRequestRoot(this.#dispatchBound, request, this.#rootOptions);
    }

    /** @internal Stable dispatch reference: runInRequestRoot receives this one function
     * for the app's lifetime and threads the request through as an argument. */
    readonly #dispatchBound = (request: Request): Response | Promise<Response> => this.#dispatch(request);

    /** @internal Built once on first use; see handle(). */
    #rootOptions: { onCleanupError?: ((error: unknown) => void) | undefined } | null = null;

    /**
     * @internal The throwing core `handle` wraps. Synchronous end to end when the route's
     * handler returns a plain Response - a sync handler pays no promise machinery in the
     * dispatch itself (handle()'s one await settles either shape).
     */
    #dispatch(request: Request): Response | Promise<Response>
    {
        const pathname = pathnameOf(request.url);
        const result = this.#router.match(request.method, pathname);

        if (result.kind === 'miss')
        {
            // A routing miss is routine control flow, not an exception. When an error observer is
            // watching OR a custom error serializer is set (so the 404 must take the app's envelope,
            // not the cached default), throw so it flows through the one error path with the path;
            // otherwise return the cached response directly - no Error, no stack capture, no
            // per-request serialization.
            if (this.#options.onError !== undefined || this.#options.serializeError !== undefined)
            {
                throw new NotFoundError(`Nothing is served at ${ request.method } ${ pathname }.`);
            }
            return notFoundResponse();
        }
        if (result.kind === 'method-mismatch')
        {
            throw new MethodNotAllowedError(result.allowed);
        }
        if (result.kind === 'decode-error')
        {
            // The target is not a valid URI, so this is a syntax failure, not a missing resource.
            throw new BadRequestError('The request target is not a valid URI.', { code: 'malformed-path' });
        }

        const out = result.value(new DispatchContext(result.params, request));
        if (out instanceof Promise)
        {
            return out.then((response) => finishDispatch(request, response));
        }
        return finishDispatch(request, out);
    }
}
