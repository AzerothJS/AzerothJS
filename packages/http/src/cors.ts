/**
 * MODULE: http/cors - Cross-Origin Resource Sharing at the edge
 *
 * CORS is two responsibilities and this middleware owns both. A preflight (an OPTIONS with an
 * Access-Control-Request-Method) is answered HERE with 204 and the negotiated headers - it
 * never reaches a route, so handlers never see the browser's bookkeeping. A real cross-origin
 * request runs the app, and the CORS response headers are added to whatever it returned.
 *
 * The origin decision is one predicate: an exact string, an allowlist, a function, or `true`
 * to reflect any origin. A request with no Origin header is same-origin and passes through
 * untouched. Credentials force a specific origin echo (the spec forbids `*` with credentials),
 * and `Vary: Origin` is appended - never overwritten - so a cache keyed on it stays correct
 * alongside the compression layer's own `Vary`.
 */

import type { EdgeMiddleware } from './edge.ts';
import { withResponseHeaders } from './edge.ts';
import { PayloadResponse } from './payload.ts';

export type CorsOrigin = string | string[] | boolean | ((origin: string) => boolean);

export interface CorsOptions
{
    /** Allowed origin(s): an exact string, an allowlist, a predicate, or `true` to reflect any. */
    origin: CorsOrigin;

    /** Methods advertised on preflight (default GET, HEAD, PUT, PATCH, POST, DELETE). */
    methods?: string[];

    /** Allowed request headers on preflight (default: reflect the browser's requested list). */
    allowedHeaders?: string[];

    /** Response headers a browser may read beyond the safelisted set. */
    exposedHeaders?: string[];

    /** Send Access-Control-Allow-Credentials (default false). Forbids a `*` origin echo. */
    credentials?: boolean;

    /** Preflight cache lifetime in seconds (default 600). */
    maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

/** @internal Is this origin allowed by the configured predicate? */
function isAllowed(origin: string, spec: CorsOrigin): boolean
{
    if (typeof spec === 'boolean')
    {
        return spec;
    }
    if (typeof spec === 'string')
    {
        return origin === spec;
    }
    if (Array.isArray(spec))
    {
        return spec.includes(origin);
    }
    return spec(origin);
}

/** @internal Appends a token to an existing Vary header without duplication or overwrite. */
function appendVary(existing: string | null, token: string): string
{
    if (existing === null || existing === '')
    {
        return token;
    }
    const present = existing.split(',').some((part) => part.trim().toLowerCase() === token.toLowerCase());
    return present ? existing : `${ existing }, ${ token }`;
}

/**
 * Cross-Origin Resource Sharing. Answers preflights directly and decorates real cross-origin
 * responses; same-origin requests (no Origin header) pass through unchanged.
 */
export function cors(options: CorsOptions): EdgeMiddleware
{
    const methods = (options.methods ?? DEFAULT_METHODS).join(', ');
    const maxAge = String(options.maxAgeSeconds ?? 600);
    const exposed = options.exposedHeaders?.join(', ');
    const credentials = options.credentials === true;

    /** The value for Access-Control-Allow-Origin, or null when the origin is not allowed. */
    const allowOrigin = (origin: string): string | null =>
    {
        if (!isAllowed(origin, options.origin))
        {
            return null;
        }
        // A wildcard is illegal with credentials, and pointless when we already know the origin.
        return options.origin === true && !credentials ? '*' : origin;
    };

    return (next) => ({
        async handle(request: Request): Promise<Response>
        {
            const origin = request.headers.get('origin');
            if (origin === null)
            {
                return next.handle(request); // not a cross-origin request
            }
            const acao = allowOrigin(origin);

            // Preflight: an OPTIONS carrying the browser's intended method. Answer it here.
            if (request.method === 'OPTIONS' && request.headers.get('access-control-request-method') !== null)
            {
                const headers: Record<string, string> = { vary: 'Origin' };
                if (acao !== null)
                {
                    headers['access-control-allow-origin'] = acao;
                    headers['access-control-allow-methods'] = methods;
                    headers['access-control-max-age'] = maxAge;
                    const requested = request.headers.get('access-control-request-headers');
                    const allowHeaders = options.allowedHeaders?.join(', ') ?? requested;
                    if (allowHeaders !== null)
                    {
                        headers['access-control-allow-headers'] = allowHeaders;
                    }
                    if (credentials)
                    {
                        headers['access-control-allow-credentials'] = 'true';
                    }
                }
                return new PayloadResponse(new Uint8Array(0), 204, headers);
            }

            // Real request: run the app, then add the CORS headers to its response.
            const response = await next.handle(request);
            const extra: Record<string, string> = { vary: appendVary(response.headers.get('vary'), 'Origin') };
            if (acao !== null)
            {
                extra['access-control-allow-origin'] = acao;
                if (credentials)
                {
                    extra['access-control-allow-credentials'] = 'true';
                }
                if (exposed !== undefined)
                {
                    extra['access-control-expose-headers'] = exposed;
                }
            }
            return withResponseHeaders(response, extra);
        }
    });
}
