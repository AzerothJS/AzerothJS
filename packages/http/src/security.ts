/**
 * MODULE: http/security - baseline response security headers
 *
 * The zero-dependency answer to helmet: a set of well-understood response headers, safe
 * defaults on, each one overridable or removable. Nothing here is application policy (a CSP
 * or a Permissions-Policy is yours to author) - these are the headers that are correct for
 * almost every server and forgotten by almost every one that does not use a library.
 *
 * Defaults set: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Cross-Origin-Opener-
 * Policy, Cross-Origin-Resource-Policy, X-DNS-Prefetch-Control. HSTS, Permissions-Policy, and
 * CSP are opt-in - each can break a working app if applied blindly, so you turn them on
 * deliberately. HSTS additionally refuses to emit over a plaintext hop: a Strict-Transport-
 * Security header on http would pin clients to a scheme this connection cannot prove.
 */

import type { EdgeMiddleware } from './edge.ts';
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
}

/** @internal True when this request arrived over TLS (direct or via a terminating proxy). */
function isSecure(request: Request): boolean
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
    return request.headers.get('x-forwarded-proto') === 'https';
}

/** @internal Builds the static portion of the header set once, at wiring time. */
function staticHeaders(options: SecurityHeadersOptions): Record<string, string>
{
    const headers: Record<string, string> = {};
    const set = (name: string, value: string | false | undefined, fallback: string): void =>
    {
        if (value === false)
        {
            return;
        }
        headers[name] = value ?? fallback;
    };

    set('x-content-type-options', options.contentTypeOptions, 'nosniff');
    set('x-frame-options', options.frameOptions, 'SAMEORIGIN');
    set('referrer-policy', options.referrerPolicy, 'no-referrer');
    set('cross-origin-opener-policy', options.crossOriginOpenerPolicy, 'same-origin');
    set('cross-origin-resource-policy', options.crossOriginResourcePolicy, 'same-origin');
    set('x-dns-prefetch-control', options.dnsPrefetchControl, 'off');

    if (typeof options.permissionsPolicy === 'string')
    {
        headers['permissions-policy'] = options.permissionsPolicy;
    }
    if (typeof options.contentSecurityPolicy === 'string')
    {
        headers['content-security-policy'] = options.contentSecurityPolicy;
    }
    return headers;
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
 * Adds baseline security headers to every response. Defaults are safe for almost any server;
 * pass options to override a value, `false` to drop one, or enable the opt-in headers (HSTS,
 * Permissions-Policy, CSP). HSTS is emitted only over a proven-secure connection.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): EdgeMiddleware
{
    const base = staticHeaders(options);
    const hsts = options.hsts;

    return (next) => ({
        async handle(request: Request): Promise<Response>
        {
            const response = await next.handle(request);
            let headers = base;
            if (hsts !== undefined && hsts !== false && isSecure(request))
            {
                headers = { ...base, 'strict-transport-security': hstsValue(hsts) };
            }
            return withResponseHeaders(response, headers);
        }
    });
}
