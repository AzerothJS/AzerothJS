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

import type { WebHandler } from './adapter-node.ts';
import { PayloadResponse } from './payload.ts';

/**
 * A decorator over a request handler. Wrap `next`, returning a handler that may inspect the
 * request, answer directly, delegate, and transform the response. The one composition unit
 * for edge concerns (request id, security headers, CORS, rate limiting).
 */
export type EdgeMiddleware = (next: WebHandler) => WebHandler;

/**
 * Composes edge middleware around an app, FIRST argument outermost: `pipeline(app, cors, rl)`
 * runs cors, then rate limiting, then the app, and unwinds responses back out through each.
 * The result is a `WebHandler` - hand it to `serve()`, or call `.handle()` in a test.
 */
export function pipeline(app: WebHandler, ...middleware: EdgeMiddleware[]): WebHandler
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
    return handler;
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

    return (next) => ({
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
    });
}
