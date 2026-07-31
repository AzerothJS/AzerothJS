/**
 * MODULE: http/edge - cross-cutting concerns that wrap the whole app
 *
 * The app's own middleware (app.use) runs BEFORE the handler: it accumulates typed context or
 * short-circuits, and it never sees the response - which is exactly right for auth, parsed
 * bodies, and guards. But some production concerns are about the RESPONSE: a request id echoed
 * back, security headers on every reply, CORS headers on the real answer, rate-limit counters.
 * Those live one layer out, as decorators over the whole app.
 *
 * An edge middleware is a plain `(next) => next` function over a `WebHandler`: it receives the
 * request, may answer or delegate, and may transform whatever comes back. It is honest about
 * the architecture's rule that a response is a VALUE - it returns a new Response, it does not
 * mutate a channel. `pipeline(app, a, b, c)` composes them with `a` outermost, yielding a
 * `WebHandler` you pass straight to `serve()`. In-process tests call `.handle(new Request(...))`
 * on the result, so the whole stack is exercised without a socket.
 */

/** What composition and adapters need from the app - exactly the kernel dispatcher's shape. */
export interface WebHandler
{
    handle(request: Request): Promise<Response>;
}
import { PayloadResponse } from './payload.ts';
import { errorResponse } from './errors.ts';

/**
 * A decorator over a request handler. Wrap `next`, returning a handler that may inspect the
 * request, answer directly, delegate, and transform the response. The one composition unit
 * for edge concerns (request id, security headers, CORS, rate limiting).
 */
export type HandlerWrapper = (next: WebHandler) => WebHandler;

/**
 * @internal The brand that lets {@link App.use} tell an EDGE middleware from an app middleware.
 *
 * Both are single-argument functions, so nothing observable at runtime distinguishes them and an
 * overload resolved by types alone would silently pick the wrong one for a JavaScript caller.
 * Marking the four framework wrappers is what allows ONE verb to accept both kinds instead of the
 * framework growing a second one.
 */
export const EDGE: unique symbol = Symbol('azerothjs.http.edge');

/** An edge middleware: a {@link HandlerWrapper} marked so `use` can recognise it. */
export type EdgeMiddleware = HandlerWrapper & { readonly [EDGE]: true };

/**
 * Marks a wrapper as edge middleware.
 *
 * Applied by `cors`, `requestId`, `rateLimit` and `securityHeaders` to their return value. The
 * value stays an ordinary callable, so {@link pipeline} and any existing caller are unaffected -
 * the brand is additive.
 *
 * @param wrapper - The wrapper to mark.
 * @returns The same function, branded.
 * @example
 * export function myEdgeConcern(): EdgeMiddleware
 * {
 *     return edge((next) => ({ handle: (request) => next.handle(request) }));
 * }
 */
export function edge(wrapper: HandlerWrapper): EdgeMiddleware
{
    return Object.assign(wrapper, { [EDGE]: true as const });
}

/**
 * Whether `value` is an edge middleware rather than an app middleware.
 *
 * @param value - Any middleware-shaped function.
 * @returns True when the value carries the {@link EDGE} brand.
 */
export function isEdge(value: unknown): value is EdgeMiddleware
{
    return typeof value === 'function' && (value as { [EDGE]?: unknown })[EDGE] === true;
}

/**
 * Composes edge middleware around an app, FIRST argument outermost: `pipeline(app, cors, rl)`
 * runs cors, then rate limiting, then the app, and unwinds responses back out through each.
 * The result is a `WebHandler` - hand it to `serve()`, or call `.handle()` in a test.
 */
export function pipeline(app: WebHandler, ...middleware: HandlerWrapper[]): WebHandler
{
    let handler = app;
    for (let i = middleware.length - 1; i >= 0; i--)
    {
        const wrap = middleware[i];
        if (wrap !== undefined)
        {
            handler = wrap(handler);
        }
    }

    // The composed handler must keep the kernel's contract - never throws, never rejects - or the
    // adapter has nothing to write and the rejection escapes to the process. Middleware run
    // OUTSIDE App.handle's error path, so a throwing origin predicate, a rate-limit store that
    // rejects, or any user middleware would otherwise be a one-request process kill.
    const composed = handler;
    return {
        handle: async (request: Request): Promise<Response> =>
        {
            try
            {
                return await composed.handle(request);
            }
            catch (error)
            {
                return errorResponse(error, { request });
            }
        }
    };
}

/**
 * Returns a response with `extra` headers merged in (names lowercased, overwriting). Uses the
 * PayloadResponse fast path when possible - mutating the `headers` view alone would not reach
 * the record the Node adapter writes, so a kernel-built response is rebuilt over the same
 * bytes; any other response is re-wrapped once over its existing body.
 */
export function withResponseHeaders(response: Response, extra: Record<string, string>): Response
{
    if (response instanceof PayloadResponse)
    {
        return response.withHeaders(extra);
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(extra))
    {
        headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const REQUEST_ID = Symbol.for('azerothjs.http.requestId');

/** The correlation id assigned to this request by {@link requestId}, if that middleware ran. */
export function requestIdOf(request: Request): string | undefined
{
    return (request as { [REQUEST_ID]?: string })[REQUEST_ID];
}

export interface RequestIdOptions
{
    /** Header carrying the id, both inbound and outbound (default `x-request-id`). */
    header?: string;

    /** Mints a fresh id when none is trusted inbound (default `crypto.randomUUID`). */
    generate?: () => string;

    /**
     * Honor a well-formed inbound id instead of always minting (default true). A proxy or an
     * upstream service that already assigned an id keeps it, so one id spans the whole hop.
     * Malformed ids (control chars, over-long) are never trusted - they are a header-injection
     * vector - and a fresh one is minted instead.
     */
    trustInbound?: boolean;
}

/** An inbound id worth trusting: visible ASCII, no controls or whitespace, bounded length. */
const VALID_ID = /^[\x21-\x7e]{1,200}$/;

/**
 * Assigns every request a correlation id: honor a well-formed inbound one or mint a UUID,
 * expose it on the request (see {@link requestIdOf}) for handlers and the logger, and echo it
 * on the response so a client and its logs share one id across the whole call.
 */
export function requestId(options: RequestIdOptions = {}): EdgeMiddleware
{
    const header = (options.header ?? 'x-request-id').toLowerCase();
    const generate = options.generate ?? ((): string => crypto.randomUUID());
    const trustInbound = options.trustInbound ?? true;

    return edge((next) => ({
        async handle(request: Request): Promise<Response>
        {
            let id: string | undefined;
            if (trustInbound)
            {
                const inbound = request.headers.get(header);
                if (inbound !== null && VALID_ID.test(inbound))
                {
                    id = inbound;
                }
            }
            id ??= generate();
            (request as { [REQUEST_ID]?: string })[REQUEST_ID] = id;

            const response = await next.handle(request);
            return withResponseHeaders(response, { [header]: id });
        }
    }));
}
