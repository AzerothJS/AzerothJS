/**
 * MODULE: http/cookies - cookie parsing and Set-Cookie serialization
 *
 * Two small, strict functions. `parseCookies` reads the request's Cookie header into a plain
 * record (first value wins on duplicates, matching every server's observable behavior).
 * `serializeCookie` builds one Set-Cookie value and VALIDATES what it emits: an invalid name,
 * a value with a semicolon, a __Secure- prefix without Secure - each is a thrown error at the
 * call site, not a silently truncated cookie discovered in production. Cookies are where
 * silent truncation becomes a session-fixation bug; loud beats lenient.
 *
 * Encoding policy: values are URI-component encoded on write and decoded on read - the one
 * scheme that round-trips arbitrary strings through the cookie-octet grammar without
 * surprises. Names are NOT encoded; an invalid name is an error.
 */

/** RFC 6265 token: the characters a cookie NAME may contain. */
const NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Reads the request's cookies. Malformed pairs are skipped, never thrown - inbound is hostile. */
export function parseCookies(request: Request): Record<string, string>
{
    const header = request.headers.get('cookie');
    const cookies: Record<string, string> = {};
    if (header === null)
    {
        return cookies;
    }
    for (const pair of header.split(';'))
    {
        const equals = pair.indexOf('=');
        if (equals === -1)
        {
            continue;
        }
        const name = pair.slice(0, equals).trim();
        if (name === '' || name in cookies)
        {
            continue; // first value wins; empty names are noise
        }
        let value = pair.slice(equals + 1).trim();
        if (value.startsWith('"') && value.endsWith('"'))
        {
            value = value.slice(1, -1); // the optional RFC 6265 quoted form
        }
        try
        {
            cookies[name] = decodeURIComponent(value);
        }
        catch
        {
            cookies[name] = value; // not our encoding; deliver verbatim rather than drop
        }
    }
    return cookies;
}

export interface CookieOptions
{
    /** Seconds until expiry. Omit both maxAge and expires for a session cookie. */
    maxAge?: number;

    /** Absolute expiry (Max-Age wins in every modern client when both are present). */
    expires?: Date;

    /** Scope path (default '/': the whole site, which is almost always what is meant). */
    path?: string;

    /** Scope domain. Omit to bind the cookie to the exact origin host. */
    domain?: string;

    /** Only send over TLS. Required for SameSite=None and the __Secure-/__Host- prefixes. */
    secure?: boolean;

    /** Hide from document.cookie (default true - scripts rarely have business reading cookies). */
    httpOnly?: boolean;

    /** Cross-site send policy (default 'lax', the modern browser default made explicit). */
    sameSite?: 'strict' | 'lax' | 'none';
}

/**
 * Builds one Set-Cookie header value with safe defaults: Path=/, HttpOnly, SameSite=Lax.
 * Throws on anything that would silently emit a different cookie than the code says:
 * invalid names, unencodable attribute values, SameSite=None without Secure, and the
 * __Secure-/__Host- prefix contracts (the browser ENFORCES those; emitting a violating
 * cookie means it is silently dropped client-side).
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string
{
    if (!NAME_PATTERN.test(name))
    {
        throw new Error(`"${ name }" is not a valid cookie name.`);
    }

    const secure = options.secure ?? false;
    const sameSite = options.sameSite ?? 'lax';

    if (sameSite === 'none' && !secure)
    {
        throw new Error('SameSite=None requires Secure - browsers reject the combination.');
    }
    if (name.startsWith('__Secure-') && !secure)
    {
        throw new Error('A __Secure- cookie must set Secure.');
    }
    if (name.startsWith('__Host-'))
    {
        if (!secure || options.domain !== undefined || (options.path ?? '/') !== '/')
        {
            throw new Error('A __Host- cookie must set Secure, no Domain, and Path=/.');
        }
    }

    const parts = [`${ name }=${ encodeURIComponent(value) }`];
    parts.push(`Path=${ options.path ?? '/' }`);
    if (options.domain !== undefined)
    {
        parts.push(`Domain=${ options.domain }`);
    }
    if (options.maxAge !== undefined)
    {
        parts.push(`Max-Age=${ Math.trunc(options.maxAge) }`);
    }
    if (options.expires !== undefined)
    {
        parts.push(`Expires=${ options.expires.toUTCString() }`);
    }
    if (secure)
    {
        parts.push('Secure');
    }
    if (options.httpOnly ?? true)
    {
        parts.push('HttpOnly');
    }
    parts.push(`SameSite=${ sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax' }`);
    return parts.join('; ');
}

/** A Set-Cookie value that deletes `name` (empty value, epoch expiry, matching scope). */
export function expireCookie(name: string, options: Pick<CookieOptions, 'path' | 'domain' | 'secure'> = {}): string
{
    return serializeCookie(name, '', { ...options, maxAge: 0, httpOnly: true });
}
