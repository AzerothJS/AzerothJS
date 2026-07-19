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
 *   - Handler context is TYPED from the route pattern: `app.get('/users/:id', ...)` receives
 *     `ctx.params: { id: string }` with no annotation, no codegen, no cast.
 *
 * `app.handle(new Request('http://local/x'))` is the entire integration-testing story - no
 * sockets, no listen(), no inject shim. Middleware compose ABOVE this dispatcher via typed
 * context accumulation (see `use`); every dispatch runs inside a request root (store
 * isolation + cleanup registry; see request-root.ts); adapters (node:http etc.) sit below.
 */

import type { PathParams } from './router.ts';
import { RadixRouter } from './router.ts';
import { HttpError, MethodNotAllowedError, NotFoundError, errorResponse, notFoundResponse, type ErrorObserver } from './errors.ts';
import { runInRequestRoot } from './request-root.ts';

/** What every handler receives beside the request. */
export interface RequestContext<Params extends Record<string, string> = Record<string, string>>
{
    /** Decoded path parameters, typed from the route pattern. */
    params: Params;

    /** The parsed request URL (parsed once by the dispatcher, shared by everyone). */
    url: URL;
}

/** A route handler: one Request in, exactly one Response out. Ctx is what middleware added. */
export type Handler<Params extends Record<string, string> = Record<string, string>, Ctx extends object = object> =
    (request: Request, ctx: RequestContext<Params> & Ctx) => Response | Promise<Response>;

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
     * Wrap every dispatch in a request root (store isolation across awaits + the
     * onRequestCleanup registry). Default true; set false only where the runtime lacks
     * AsyncLocalStorage or for micro-benchmarking the bare kernel.
     */
    requestRoot?: boolean;

    /** Observes every completed request (logging/metrics/tracing seam). */
    observe?: RequestObserver | undefined;
}

/**
 * @internal The pathname of an absolute-form URL by string scan - no URL allocation on the
 * hot path. The path starts at the first '/' after the authority and ends at '?' or '#'.
 */
function pathnameOf(url: string): string
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
    public readonly params: Record<string, string>;

    readonly #urlString: string;

    #url: URL | null = null;

    constructor(params: Record<string, string>, urlString: string)
    {
        this.params = params;
        this.#urlString = urlString;
    }

    public get url(): URL
    {
        this.#url ??= new URL(this.#urlString);
        return this.#url;
    }
}

/**
 * A middleware: reads the request and the context accumulated SO FAR, and returns either
 * the context it ADDS (an object, merged for everything downstream), a Response (short
 * circuit: guards deny, caches answer early), or nothing. There is no `next()` - control
 * flow is the return value, and the chain is composed once per route at registration.
 */
export type Middleware<Ctx extends object, Added extends Record<string, unknown>> =
    (request: Request, ctx: RequestContext & Ctx) =>
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps bare-return/no-return observers assignable; null is accepted as "adds nothing" for JS callers
    Added | Response | null | undefined | void | Promise<Added | Response | null | undefined | void>;

/**
 * A named, versioned server plugin: the packaged form of the `app.plugin(fn)` functional seam.
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

export class App<Ctx extends object = object>
{
    readonly #router = new RadixRouter<Handler>();

    readonly #options: AppOptions;

    /** The middleware registered so far; each route snapshots this list when registered. */
    readonly #middlewares: Array<Middleware<object, Record<string, unknown>>> = [];

    /** Installed named plugins, in registration order (introspected via {@link plugins}). */
    readonly #installed: Array<{ name: string; version?: string | undefined }> = [];

    constructor(options: AppOptions = {})
    {
        this.#options = options;
    }

    /**
     * Appends a middleware. Its returned object joins the context TYPE for every route
     * registered AFTER it - ordering is lexical: what you read top-to-bottom is what runs,
     * and a route above a `use` is untouched by it. The runtime merge happens in the
     * composed chain; middleware never mutate the context directly, they return additions.
     */
    public use<Added extends Record<string, unknown> = Record<never, never>>(
        middleware: Middleware<Ctx, Added>
    ): App<Ctx & Added>
    {
        this.#middlewares.push(middleware as Middleware<object, Record<string, unknown>>);
        return this as unknown as App<Ctx & Added>;
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
                Object.assign(ctx, result);
            }
            return null;
        };
        const composed: Handler = (request, ctx) =>
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
                    const result = middleware(request, ctx);
                    if (result instanceof Promise)
                    {
                        const after = i + 1;
                        return result.then((resolved) => applyResult(ctx, resolved) ?? step(after));
                    }
                    const short = applyResult(ctx, result);
                    if (short !== null)
                    {
                        return short;
                    }
                }
                return (handler as Handler)(request, ctx);
            };
            return step(0);
        };
        this.#router.insert(method, pattern, composed);
        return this;
    }

    public get<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('GET', pattern, handler);
    }

    public post<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('POST', pattern, handler);
    }

    public put<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('PUT', pattern, handler);
    }

    public patch<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('PATCH', pattern, handler);
    }

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
     */
    public query<P extends string>(pattern: P, handler: Handler<PathParams<P> & Record<string, string>, Ctx>): this
    {
        return this.route('QUERY', pattern, handler);
    }

    /**
     * Applies a plugin - a plain function over this app returning the (possibly more
     * capable) app. There is no registration graph, no encapsulation scopes, no deferred
     * boot: `app.plugin(auth).plugin(metrics)` IS the composition, typed end to end, and
     * what a plugin does is exactly what its body says.
     */
    public plugin<Out extends object>(fn: (app: App<Ctx>) => App<Out>): App<Out>
    {
        return fn(this);
    }

    /**
     * Registers a NAMED plugin ({@link AzerothPlugin}) - the packaged form of {@link plugin}.
     * Beyond running `install`, it records the plugin and REJECTS a second registration under
     * the same name (a duplicate is almost always a wiring mistake - two copies of a plugin, or
     * two versions - and applying it twice would double its middleware/routes). The plugin's
     * context additions flow into the returned app's type, so routes registered afterwards see
     * them. Use {@link plugin} for a one-off anonymous transform; use this for a shipped module.
     */
    public register<Out extends object>(plugin: AzerothPlugin<Ctx, Out>): App<Out>
    {
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
            if (this.#options.requestRoot === false)
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
        }
        catch (error)
        {
            response = errorResponse(error, { dev: this.#options.dev, observe: this.#options.onError });
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
            // A routing miss is routine control flow, not an exception. When an error observer
            // is watching, throw so it still sees the 404 (with the path); otherwise return the
            // cached response directly - no Error, no stack capture, no per-request serialization.
            if (this.#options.onError !== undefined)
            {
                throw new NotFoundError(`Nothing is served at ${ request.method } ${ pathname }.`);
            }
            return notFoundResponse();
        }
        if (result.kind === 'method-mismatch')
        {
            throw new MethodNotAllowedError(result.allowed);
        }

        const out = result.value(request, new DispatchContext(result.params, request.url));
        if (out instanceof Promise)
        {
            return out.then((response) => finishDispatch(request, response));
        }
        return finishDispatch(request, out);
    }
}

/** Re-exported so `throw new HttpError(...)` and `new App()` come from one import. */
export { HttpError };
