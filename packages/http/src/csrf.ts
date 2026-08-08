/**
 * MODULE: csrf - double-submit cookie plus origin policy
 *
 * The browser threat CSRF names: a hostile page making the victim's browser send a
 * state-changing request with the victim's AMBIENT credentials (cookies). Two independent
 * checks reject it:
 *
 *   - ORIGIN POLICY: `Sec-Fetch-Site` / `Origin` must name this origin (or an allowlisted
 *     one). Modern browsers always send at least one of them on cross-site POSTs.
 *   - DOUBLE SUBMIT: a random token rides a JS-READABLE cookie ({@link csrfCookie} mints
 *     it; httpOnly false is the point), and the caller must mirror it into a header. A
 *     cross-site attacker can make the browser SEND the cookie but can never READ it.
 *
 * Non-browser callers hold no ambient credentials, so the defense is not for them: a
 * server-to-server client mints its own pair (same random value as cookie and header), or
 * the route drops {@link csrfProtect} in favor of token auth.
 *
 * Kernel-pure by construction: web crypto only, no node:* - the purity test enforces it.
 */

import { parseCookies, serializeCookie } from './cookies.ts';
import { ForbiddenError } from './errors.ts';
import { edge } from './edge.ts';
import type { EdgeMiddleware } from './edge.ts';
import type { GuardContext } from './api/declare.ts';

/** Shared knobs for {@link csrfCookie} and {@link csrfProtect} - pass the SAME object to both. */
export interface CsrfOptions
{
    /** Cookie name. Default `__Host-azcsrf` when secure, `azcsrf` when `secure: false`. */
    cookie?: string;

    /** The header the caller mirrors the cookie into. Default `x-azeroth-csrf`. */
    header?: string;

    /**
     * Emit the Secure cookie under the `__Host-` prefix (default true). Set false ONLY for
     * plain-http development - the prefix is what pins the cookie to this exact host.
     */
    secure?: boolean;

    /** Origins beyond the request's own (`scheme://host[:port]`, exact) allowed to submit. */
    allowedOrigins?: readonly string[];
}

/** @internal The shortest cookie token the guard accepts - anything shorter was not minted here. */
const MIN_TOKEN_LENGTH = 16;

/** @internal Methods that must stay side-effect-free by HTTP contract; the guard passes them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @internal The effective cookie name for the options. */
function cookieNameOf(options: CsrfOptions): string
{
    return options.cookie ?? (options.secure === false ? 'azcsrf' : '__Host-azcsrf');
}

/** Mints one token: 32 random bytes as base64url. */
export function csrfToken(): string
{
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes)
    {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @internal Constant-time equality over the two token strings. Pure JS on char codes - the
 * kernel has no node:crypto - and enough here: the compared values are high-entropy random
 * tokens, not passwords.
 */
function tokensEqual(a: string, b: string): boolean
{
    if (a.length !== b.length)
    {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++)
    {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Edge middleware minting the token cookie on GET responses that arrive without one. The
 * cookie is deliberately readable (httpOnly false): double submit works BECAUSE the page's
 * own JS can read it and a cross-site attacker cannot.
 */
export function csrfCookie(options: CsrfOptions = {}): EdgeMiddleware
{
    const name = cookieNameOf(options);
    const secure = options.secure !== false;
    return edge((next) => ({
        handle: async (request: Request): Promise<Response> =>
        {
            const response = await next.handle(request);
            if (request.method !== 'GET' || parseCookies(request)[name] !== undefined)
            {
                return response;
            }
            const cookie = serializeCookie(name, csrfToken(), { secure, httpOnly: false, sameSite: 'lax', path: '/' });
            // APPEND, never set: a handler's own Set-Cookie must survive the minting.
            const headers = new Headers();
            response.headers.forEach((value, key) =>
            {
                if (key !== 'set-cookie')
                {
                    headers.set(key, value);
                }
            });
            for (const existing of response.headers.getSetCookie())
            {
                headers.append('set-cookie', existing);
            }
            headers.append('set-cookie', cookie);
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
    }));
}

/**
 * The CSRF guard: rejects a state-changing request unless its origin checks out AND the
 * cookie token is mirrored in the header. A plain guard - compose it anywhere the chain
 * runs: `feature('/x', [csrfProtect(csrf)], ...)`, `routes.with(csrfProtect(csrf))`, or
 * `app.with(csrfProtect(csrf))`. Reads headers only, never the body, so it can never trip
 * the body-consumed check downstream.
 */
export function csrfProtect(options: CsrfOptions = {}): (context: GuardContext) => void
{
    const name = cookieNameOf(options);
    const header = options.header ?? 'x-azeroth-csrf';
    const allowed = new Set(options.allowedOrigins ?? []);

    return (context: GuardContext): void =>
    {
        if (SAFE_METHODS.has(context.request.method))
        {
            return;
        }
        const origin = context.request.headers.get('origin');
        const originAllowed = origin !== null && (origin === context.url.origin || allowed.has(origin));
        const site = context.request.headers.get('sec-fetch-site');
        // `same-site` is a SIBLING subdomain - not this origin; only an allowlist re-admits it.
        if (site !== null && site !== 'same-origin' && site !== 'none' && !originAllowed)
        {
            throw new ForbiddenError('Cross-site request rejected.', { code: 'csrf' });
        }
        if (origin !== null && origin !== context.url.origin && !allowed.has(origin))
        {
            throw new ForbiddenError('Request origin rejected.', { code: 'csrf' });
        }
        const cookie = parseCookies(context.request)[name];
        const mirrored = context.request.headers.get(header);
        if (cookie === undefined || cookie.length < MIN_TOKEN_LENGTH || mirrored === null || !tokensEqual(cookie, mirrored))
        {
            throw new ForbiddenError('Missing or mismatched CSRF token.', { code: 'csrf' });
        }
    };
}
