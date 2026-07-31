/**
 * MODULE: http/cors - Cross-Origin Resource Sharing at the edge
 *
 * CORS is two responsibilities and this middleware owns both. A preflight (an OPTIONS with an
 * Access-Control-Request-Method) is answered HERE with 204 and the negotiated headers, but it
 * still traverses the inner middleware first, so metering wired inside this layer (a rate
 * limiter) counts every preflight; only the inner response is discarded - routes do not
 * implement the browser's bookkeeping. A real cross-origin request runs the app, and the CORS
 * response headers are added to whatever it returned.
 *
 * The origin decision is one predicate: an exact string, an allowlist, a function, or `true`
 * to reflect any origin. Origin is attacker-controlled (browsers send the literal `null` for
 * sandboxed frames, data: and file: documents), so a throwing predicate is a denial, never a
 * rejection. Credentials refuse `origin: true` at wiring time - reflecting every origin with
 * credentials hands authenticated bodies to any site, which is strictly worse than the `*`
 * the spec forbids - and a predicate under credentials never allows the shared `null` origin.
 * `Vary: Origin` is appended - never overwritten - on every path, the no-Origin one included,
 * so a cache keyed on it stays correct alongside the compression layer's own `Vary`.
 */

import { withResponseHeaders, edge, type EdgeMiddleware } from './edge.ts';
import { PayloadResponse } from './payload.ts';

export type CorsOrigin = string | string[] | boolean | ((origin: string) => boolean);

export interface CorsOptions
{
    /** Allowed origin(s): an exact string, an allowlist, a predicate, or `true` to reflect any. */
    origin: CorsOrigin;

    /** Methods advertised on preflight (default GET, HEAD, PUT, PATCH, POST, DELETE). */
    methods?: string[];

    /** Allowed request headers on preflight (default: the CORS safelist - Accept, Accept-Language, Content-Language, Content-Type). */
    allowedHeaders?: string[];

    /** Response headers a browser may read beyond the safelisted set. */
    exposedHeaders?: string[];

    /** Send Access-Control-Allow-Credentials (default false). Refuses `origin: true` and the `null` origin. */
    credentials?: boolean;

    /** Preflight cache lifetime in seconds (default 600). */
    maxAgeSeconds?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

/** The request headers a preflight approves when no explicit list is configured. */
const DEFAULT_ALLOWED_HEADERS = 'Accept, Accept-Language, Content-Language, Content-Type';

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
    try
    {
        return spec(origin);
    }
    catch
    {
        // Origin is attacker-controlled: the idiomatic `new URL(origin)` predicate throws on
        // the literal `null` a browser itself sends. A throw is a denial, never a rejection.
        return false;
    }
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
    const credentials = options.credentials === true;
    if (credentials && options.origin === true)
    {
        throw new Error('cors: `origin: true` with credentials reflects every origin with cookies attached - list the origins you trust instead.');
    }

    const methods = (options.methods ?? DEFAULT_METHODS).join(', ');
    const maxAge = String(options.maxAgeSeconds ?? 600);
    const exposed = options.exposedHeaders?.join(', ');
    const allowHeaders = options.allowedHeaders?.join(', ') ?? DEFAULT_ALLOWED_HEADERS;

    /** The value for Access-Control-Allow-Origin, or null when the origin is not allowed. */
    const allowOrigin = (origin: string): string | null =>
    {
        // `null` is the shared opaque origin (sandboxed frames, data:, file:) - countless
        // distinct documents present it, so a predicate match cannot make it credential-worthy.
        if (credentials && origin === 'null' && typeof options.origin === 'function')
        {
            return null;
        }
        if (!isAllowed(origin, options.origin))
        {
            return null;
        }
        // A wildcard is illegal with credentials, and pointless when we already know the origin.
        return options.origin === true && !credentials ? '*' : origin;
    };

    return edge((next) => ({
        async handle(request: Request): Promise<Response>
        {
            const origin = request.headers.get('origin');
            if (origin === null)
            {
                // Same-origin request: no CORS headers, but the response still varies by Origin.
                const response = await next.handle(request);
                return withResponseHeaders(response, { vary: appendVary(response.headers.get('vary'), 'Origin') });
            }
            const acao = allowOrigin(origin);

            // Preflight: an OPTIONS carrying the browser's intended method. The answer is
            // negotiated here, but the request still runs the inner chain so a limiter wired
            // inside this layer meters it; the inner response is discarded - except a
            // rate-limit refusal, which must stay a refusal.
            if (request.method === 'OPTIONS' && request.headers.get('access-control-request-method') !== null)
            {
                const inner = await next.handle(request);
                if (inner.status === 429)
                {
                    return withResponseHeaders(inner, { vary: appendVary(inner.headers.get('vary'), 'Origin') });
                }
                if (inner.body !== null)
                {
                    await inner.body.cancel();
                }
                const headers: Record<string, string> = {};
                for (const [name, value] of inner.headers)
                {
                    headers[name] = value;
                }
                delete headers['content-type'];
                delete headers['content-length'];
                headers.vary = appendVary(inner.headers.get('vary'), 'Origin');
                if (acao !== null)
                {
                    headers['access-control-allow-origin'] = acao;
                    headers['access-control-allow-methods'] = methods;
                    headers['access-control-max-age'] = maxAge;
                    headers['access-control-allow-headers'] = allowHeaders;
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
    }));
}
