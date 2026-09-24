/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Double-submit cookie plus origin policy.
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
import { isSharedDispatch } from './api/bridge.ts';

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

/**
 * @internal The path `csrfCookie` answers with a token cookie, under any prefix. A page a
 * shared cache may store carries no token, so `<Form>` and the typed client ask here first.
 */
const CSRF_TOKEN_PATH = '/__azeroth/csrf';

/** @internal The answer header naming the cookie this layer compares and its token. */
const CSRF_PAIR_HEADER = 'x-azeroth-csrf-cookie';

/** @internal The effective cookie name for the options. */
function cookieNameOf(options: CsrfOptions): string
{
    return options.cookie ?? (options.secure === false ? 'azcsrf' : '__Host-azcsrf');
}

/**
 * @internal Whether a request came from a page of this origin: `Sec-Fetch-Site: same-origin`, or
 * none over plain http off loopback, where browsers send none, and no other `Origin`.
 */
function fromOwnPage(request: Request): boolean
{
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    // Browsers send Sec-Fetch-Site only to a trustworthy origin; there, none gets no pair.
    const trustworthy = url.protocol === 'https:' || /^(localhost|127(\.\d+){3}|\[::1\])$|\.localhost$/.test(url.hostname);
    return (site === 'same-origin' || (site === null && !trustworthy)) && (origin === null || origin === url.origin);
}

/**
 * @internal Whether the request carries two values under `name`. This layer sets one host-only
 * cookie, so the other came from another host, and nothing says which is this visitor's own.
 */
function heldTwice(request: Request, name: string): boolean
{
    const values = (request.headers.get('cookie') ?? '').split(';')
        .filter((pair) => pair.includes('=') && pair.slice(0, pair.indexOf('=')).trim() === name)
        .map((pair) => pair.slice(pair.indexOf('=') + 1).trim());
    return new Set(values).size > 1;
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

/** @internal Whether a cache directive list keeps the response out of the cache it addresses. */
function keepsOut(control: string): boolean
{
    return control.toLowerCase().split(',').some((directive) => ['private', 'no-store'].includes(directive.trim()));
}

/**
 * @internal `private` when no shared cache may store the response, `shared` when one may (a CDN
 * obeys its own `*-Cache-Control`, `Surrogate-Control` or `Edge-Control` first), else `unstated`.
 */
function cachePolicyOf(headers: Headers): 'private' | 'shared' | 'unstated'
{
    for (const [name, value] of headers)
    {
        if ((name.endsWith('-cache-control') || name === 'surrogate-control' || name === 'edge-control') && !keepsOut(value))
        {
            return 'shared';
        }
    }
    const control = headers.get('cache-control');
    if (control === null)
    {
        return headers.has('expires') ? 'shared' : 'unstated';
    }
    return keepsOut(control) ? 'private' : 'shared';
}

/**
 * @internal Appends `token` as the CSRF cookie unless a shared cache may store the response, and
 * marks one that names no policy `private`. `csrfCookie` and the kit's first-visit render share it.
 */
export function withCsrfCookie(response: Response, token: string, options: CsrfOptions = {}): Response
{
    const policy = cachePolicyOf(response.headers);
    if (policy === 'shared')
    {
        return response;
    }
    const cookie = serializeCookie(cookieNameOf(options), token, { secure: options.secure !== false, httpOnly: false, sameSite: 'lax', path: '/' });
    // APPEND, never set: a handler's own Set-Cookie must survive the minting.
    const minted = withSetCookies(response, [...response.headers.getSetCookie(), cookie]);
    if (policy === 'unstated')
    {
        minted.headers.set('cache-control', 'private');
    }
    return minted;
}

/** @internal A copy of `response` whose Set-Cookie lines are exactly `cookies`. */
function withSetCookies(response: Response, cookies: readonly string[]): Response
{
    const headers = new Headers();
    response.headers.forEach((value, key) =>
    {
        if (key !== 'set-cookie')
        {
            headers.set(key, value);
        }
    });
    for (const cookie of cookies)
    {
        headers.append('set-cookie', cookie);
    }
    // 204/205/304 forbid a body - Response() throws on any stream for them, and the
    // kernel's lazy response materializes a stream even for an empty payload.
    const body = response.status === 204 || response.status === 205 || response.status === 304
        ? null
        : response.body;
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Edge middleware minting the token cookie on GET responses that arrive without one. The
 * cookie is deliberately readable (httpOnly false): double submit works BECAUSE the page's
 * own JS can read it and a cross-site attacker cannot.
 *
 * It never mints on a response a shared cache may store (`public`, `max-age`, `s-maxage`,
 * `no-cache`, `Expires`, or a CDN's own `*-Cache-Control`, `Surrogate-Control` or
 * `Edge-Control`): a CDN would replay that one visitor's token to every visitor. A response that
 * names no policy is marked `private` before it carries the cookie. A GET to `/__azeroth/csrf`,
 * under any prefix, answers 204 `private, no-store` with the cookie, for a visitor whose page
 * came from a shared cache. To a request from this origin's own page the answer also names the
 * cookie this layer compares and its token, `x-azeroth-csrf-cookie: <name>=<token>`, so a write
 * posts the right token before `document.cookie` shows it and beside another server's cookies.
 * A token already held is named only when it is made only of letters, digits, `-` and `_` and
 * is the one value under the name, and it is then set again beside it.
 *
 * It judges only the headers set by the layers inside it, so list it before every layer that
 * sets `Cache-Control` or a CDN field (any `*-Cache-Control`, `Surrogate-Control`,
 * `Edge-Control`); the first one listed runs outermost. A `pipeline()` layer runs outside every
 * `app.use` layer, so when a `pipeline()` layer sets one, put `csrfCookie` in `pipeline()` ahead
 * of it.
 */
export function csrfCookie(options: CsrfOptions = {}): EdgeMiddleware
{
    const name = cookieNameOf(options);
    return edge((next) => ({
        handle: async (request: Request): Promise<Response> =>
        {
            const held = parseCookies(request)[name];
            const fresh = held === undefined;
            if (request.method === 'GET' && !isSharedDispatch(request) && new URL(request.url).pathname.endsWith(CSRF_TOKEN_PATH))
            {
                const token = held ?? csrfToken();
                const headers: Record<string, string> = { 'cache-control': 'private, no-store' };
                // Only to this origin's own page, never for a name held twice (one may be a plant),
                // and always beside its Set-Cookie: a cache that drops those drops the token too.
                const named = fromOwnPage(request) && /^[\w-]+$/.test(token) && !heldTwice(request, name);
                if (named)
                {
                    headers[CSRF_PAIR_HEADER] = `${ name }=${ token }`;
                }
                const answer = new Response(null, { status: 204, headers });
                return fresh || named ? withCsrfCookie(answer, token, options) : answer;
            }
            const response = await next.handle(request);
            // A shared render's in-process call reaches no browser, so a token would have no reader.
            if (request.method !== 'GET' || isSharedDispatch(request) || !fresh)
            {
                return response;
            }
            // A page that RENDERS a form needs the token while rendering, which is before this
            // layer ever sees the response - so `mountPages` mints one itself for those. Minting
            // a second here would append a rival Set-Cookie, the browser would keep the last,
            // and the form would carry the other: every first submit would fail its own check.
            const cookies = response.headers.getSetCookie();
            if (cookies.some((cookie) => cookie.startsWith(`${ name }=`)))
            {
                // A layer between the kit and here can still have made that answer shared.
                return cachePolicyOf(response.headers) === 'shared'
                    ? withSetCookies(response, cookies.filter((cookie) => !cookie.startsWith(`${ name }=`)))
                    : response;
            }
            return withCsrfCookie(response, csrfToken(), options);
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
        assertSameOrigin(context.request, context.url, allowed);
        assertTokenMirrored(context.request, name, context.request.headers.get(header));
    };
}

/**
 * @internal The origin half of the CSRF rule. Extracted so the header guard and the FORM
 * verifier below cannot drift: they enforce the same thing, and a divergence would show up
 * only as a hole on whichever path was updated second.
 */
function assertSameOrigin(request: Request, url: URL, allowed: ReadonlySet<string>): void
{
    const origin = request.headers.get('origin');
    // A browser sends the literal `null` for an opaque origin AND for a same-origin navigation
    // POST from a page served with `Referrer-Policy: no-referrer` - which `securityHeaders()`
    // sets by default. The value therefore distinguishes nothing, and it is never allowlistable:
    // an entry for it would admit every cross-site caller that blanks its own Origin, which is
    // why `cors()` refuses the same string at wiring time.
    const blanked = origin === 'null';
    const originAllowed = origin !== null && !blanked && (origin === url.origin || allowed.has(origin));
    const site = request.headers.get('sec-fetch-site');
    // `same-site` is a SIBLING subdomain - not this origin; only an allowlist re-admits it.
    if (site !== null && site !== 'same-origin' && site !== 'none' && !originAllowed)
    {
        throw new ForbiddenError('Cross-site request rejected.', { code: 'csrf' });
    }
    // What the blanked Origin cannot say, the browser says here. `Sec-Fetch-Site` is a forbidden
    // request-header name - Fetch reserves every `sec-` name, so fetch init, setRequestHeader and
    // a ServiceWorker-built Request all drop it - and `same-origin` is the browser's own
    // statement that this request did not come from another site. Exactly that value, and only
    // for a blanked Origin: `none` means there was no initiator at all, which no legitimate
    // same-origin form submit produces, and an absent header leaves nothing to trust.
    if (blanked && site === 'same-origin')
    {
        return;
    }
    if (origin !== null && !originAllowed)
    {
        // An https Origin against the same host's http URL, with a forwarded proto nothing
        // honored, is a TLS terminator in front of a serve() that never declared trustProxy.
        // Still fail closed - but name the fix, or every same-origin POST reads as hostile.
        if (url.protocol === 'http:'
            && origin === `https://${ url.host }`
            && request.headers.get('x-forwarded-proto') !== null)
        {
            throw new ForbiddenError(
                'Request origin rejected: the Origin is https but the request URL is http. '
                + 'Behind a TLS-terminating proxy, set trustProxy on serve() so the forwarded scheme is honored.',
                { code: 'csrf' });
        }
        throw new ForbiddenError('Request origin rejected.', { code: 'csrf' });
    }
}

/** @internal The token half: the cookie must exist, be long enough, and match what was mirrored. */
function assertTokenMirrored(request: Request, name: string, mirrored: string | null): void
{
    const cookie = parseCookies(request)[name];
    if (cookie === undefined || cookie.length < MIN_TOKEN_LENGTH || mirrored === null || !tokensEqual(cookie, mirrored))
    {
        throw new ForbiddenError('Missing or mismatched CSRF token.', { code: 'csrf' });
    }
}

/** The hidden input a no-JS form carries its CSRF token in. */
export const CSRF_FIELD = '_csrf';

/**
 * Verifies a request whose CSRF token arrives in the BODY rather than a header.
 *
 * A plain HTML form cannot set a header, so the header guard - which documents itself as
 * reading headers only, and must keep that promise or it would consume a body the handler
 * still needs - structurally cannot cover a no-JS submit. The caller here has already parsed
 * the body, so it hands the field value over and no second read happens.
 *
 * Same two checks, same order, same errors as {@link csrfProtect}: origin first, then the
 * mirrored token. Safe methods never reach this - a form submit is a POST by construction.
 *
 * @param request - The submitting request; its cookies carry the authoritative token.
 * @param url - The request's own URL, for the origin comparison.
 * @param submitted - The token the form carried, or null when the field was absent.
 * @param options - The same cookie/origin options the guard takes.
 * @throws {ForbiddenError} On a cross-site origin or a missing/mismatched token.
 */
export function verifyCsrfField(
    request: Request,
    url: URL,
    submitted: string | null,
    options: CsrfOptions = {}
): void
{
    assertSameOrigin(request, url, new Set(options.allowedOrigins ?? []));
    assertTokenMirrored(request, cookieNameOf(options), submitted);
}
