/**
 * MODULE: http/security - baseline response security headers
 *
 * The zero-dependency answer to helmet: a set of well-understood response headers, safe
 * defaults on, each one overridable or removable. A DEFAULT applies only where the response
 * does not already carry that header - a handler's own choice for one route wins - while a
 * value passed here explicitly always wins. Nothing here is application policy (a CSP or a
 * Permissions-Policy is yours to author) - these are the headers that are correct for almost
 * every server and forgotten by almost every one that does not use a library.
 *
 * Defaults set: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Cross-Origin-Opener-
 * Policy, Cross-Origin-Resource-Policy, X-DNS-Prefetch-Control. HSTS, Permissions-Policy, and
 * CSP are opt-in - each can break a working app if applied blindly, so you turn them on
 * deliberately. HSTS additionally refuses to emit over a plaintext hop: a Strict-Transport-
 * Security header on http would pin clients to a scheme this connection cannot prove, and a
 * client-forgeable `x-forwarded-proto` claim counts only under `trustProxy` - the same
 * boundary `clientIp` is built on.
 */

import type { HandlerWrapper } from './edge.ts';
import { withResponseHeaders } from './edge.ts';

export interface HstsOptions
{
    /** max-age in seconds (default 15552000 = 180 days). */
    maxAgeSeconds?: number;

    /** Add `includeSubDomains` (default true). */
    includeSubDomains?: boolean;

    /** Add `preload` - only set this if you have submitted the domain to the preload list. */
    preload?: boolean;
}

/** Each header defaults to a safe value; set `false` to omit it, or a string to override it. */
export interface SecurityHeadersOptions
{
    /** X-Content-Type-Options (default `nosniff`). */
    contentTypeOptions?: string | false;

    /** X-Frame-Options (default `SAMEORIGIN`). CSP `frame-ancestors` is the modern successor. */
    frameOptions?: string | false;

    /** Referrer-Policy (default `no-referrer`). */
    referrerPolicy?: string | false;

    /** Cross-Origin-Opener-Policy (default `same-origin`). */
    crossOriginOpenerPolicy?: string | false;

    /** Cross-Origin-Resource-Policy (default `same-origin`). */
    crossOriginResourcePolicy?: string | false;

    /** X-DNS-Prefetch-Control (default `off`). */
    dnsPrefetchControl?: string | false;

    /** Strict-Transport-Security - OFF by default; enable only when serving over HTTPS. */
    hsts?: HstsOptions | false;

    /** Permissions-Policy value - OFF by default (app-specific; a wrong value disables features). */
    permissionsPolicy?: string | false;

    /** Content-Security-Policy value - OFF by default (author it for your app). */
    contentSecurityPolicy?: string | false;

    /**
     * Believe `x-forwarded-proto` when deciding the hop is secure enough for HSTS (default
     * false). The header is client-forgeable, so it counts only behind a proxy you declared -
     * the same trust boundary as `clientIp`.
     */
    trustProxy?: boolean;
}

/** @internal True when this request arrived over TLS (direct, or via a proxy trusted to say so). */
function isSecure(request: Request, trustProxy: boolean): boolean
{
    try
    {
        if (new URL(request.url).protocol === 'https:')
        {
            return true;
        }
    }
    catch
    {
        // A malformed URL cannot be proven secure.
    }
    return trustProxy && request.headers.get('x-forwarded-proto') === 'https';
}

/** @internal Splits the header set once at wiring time: values the caller wrote always win,
 * while built-in fallbacks yield to a header the response already carries. */
function staticHeaders(options: SecurityHeadersOptions): { forced: Record<string, string>; defaults: Record<string, string> }
{
    const forced: Record<string, string> = {};
    const defaults: Record<string, string> = {};
    const set = (name: string, value: string | false | undefined, fallback: string): void =>
    {
        if (value === false)
        {
            return;
        }
        if (value === undefined)
        {
            defaults[name] = fallback;
        }
        else
        {
            forced[name] = value;
        }
    };

    set('x-content-type-options', options.contentTypeOptions, 'nosniff');
    set('x-frame-options', options.frameOptions, 'SAMEORIGIN');
    set('referrer-policy', options.referrerPolicy, 'no-referrer');
    set('cross-origin-opener-policy', options.crossOriginOpenerPolicy, 'same-origin');
    set('cross-origin-resource-policy', options.crossOriginResourcePolicy, 'same-origin');
    set('x-dns-prefetch-control', options.dnsPrefetchControl, 'off');

    if (typeof options.permissionsPolicy === 'string')
    {
        forced['permissions-policy'] = options.permissionsPolicy;
    }
    if (typeof options.contentSecurityPolicy === 'string')
    {
        forced['content-security-policy'] = options.contentSecurityPolicy;
    }
    return { forced, defaults };
}

/** @internal The Strict-Transport-Security value from its options. */
function hstsValue(hsts: HstsOptions): string
{
    const parts = [`max-age=${ hsts.maxAgeSeconds ?? 15_552_000 }`];
    if (hsts.includeSubDomains ?? true)
    {
        parts.push('includeSubDomains');
    }
    if (hsts.preload === true)
    {
        parts.push('preload');
    }
    return parts.join('; ');
}

/**
 * Adds baseline security headers to every response. A default applies only where the response
 * does not already carry that header, so a handler's stricter per-route choice survives; a
 * value passed here explicitly always wins. Pass `false` to drop a header, or enable the
 * opt-in ones (HSTS, Permissions-Policy, CSP). HSTS is emitted only over a proven-secure
 * connection: TLS on the URL, or a forwarded-proto claim under `trustProxy`.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): HandlerWrapper
{
    const { forced, defaults } = staticHeaders(options);
    const hsts = options.hsts;
    const trustProxy = options.trustProxy === true;

    return (next) => ({
        async handle(request: Request): Promise<Response>
        {
            const response = await next.handle(request);
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(defaults))
            {
                if (!response.headers.has(name))
                {
                    headers[name] = value;
                }
            }
            Object.assign(headers, forced);
            if (hsts !== undefined && hsts !== false && isSecure(request, trustProxy))
            {
                headers['strict-transport-security'] = hstsValue(hsts);
            }
            return withResponseHeaders(response, headers);
        }
    });
}
