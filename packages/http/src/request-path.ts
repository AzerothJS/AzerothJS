/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** @internal Index of the path, query or fragment after the authority of an absolute URL. */
export function authorityEnd(url: string, start: number): number
{
    for (let i = start; i < url.length; i++)
    {
        const ch = url.charCodeAt(i);
        if (ch === 47 || ch === 63 || ch === 35) // '/', '?', '#'
        {
            return i;
        }
    }
    return url.length;
}

/** @internal Read the original pathname without applying the URL parser's path normalization. */
export function pathnameOf(target: string): string
{
    let start = 0;
    if (!target.startsWith('/'))
    {
        const scheme = target.indexOf('://');
        start = scheme === -1 ? target.length : authorityEnd(target, scheme + 3);
        if (target.charCodeAt(start) !== 47)
        {
            return '/';
        }
    }
    for (let i = start; i < target.length; i++)
    {
        const ch = target.charCodeAt(i);
        if (ch === 63 || ch === 35)
        {
            return target.slice(start, i);
        }
    }
    return target.slice(start);
}

/** @internal Splits a pattern or pathname into nonempty segments. */
export function segmentsOf(path: string): string[]
{
    const segments: string[] = [];
    let start = 0;
    for (let i = 0; i <= path.length; i++)
    {
        if (i === path.length || path.charCodeAt(i) === 47)
        {
            if (i > start)
            {
                segments.push(path.slice(start, i));
            }
            start = i + 1;
        }
    }
    return segments;
}

/** @internal The segment sequence used for request matching, distinct from a registration pattern. */
export function requestSegments(path: string): string[] | 'miss' | 'decode-error'
{
    if (path.includes('//') || path.includes('\\'))
    {
        return 'miss';
    }
    const segments = segmentsOf(path);
    for (let i = 0; i < segments.length; i++)
    {
        let segment = segments[i];
        if (segment === undefined)
        {
            continue;
        }
        if (segment.includes('%'))
        {
            try
            {
                segment = decodeURIComponent(segment);
            }
            catch
            {
                return 'decode-error';
            }
            segments[i] = segment;
        }
        if (segment === '.' || segment === '..')
        {
            return 'miss';
        }
    }
    return segments;
}

/** @internal Preserve the boundary of each decoded component when joining a path for comparison. */
export function pathIdentity(path: string): string | null
{
    const segments = requestSegments(path);
    if (typeof segments === 'string')
    {
        return null;
    }
    return '/' + segments.map(segment => segment.replace(/[%/\\?#]/g, encodeURIComponent)).join('/');
}

const HTTP_AUTHORITY = /^https?:\/\/[^/?#\\\s]+(?=[/?#]|$)/i;

/**
 * The path identity used by HTTP routing, before checking any route registration. Accepts
 * a Request, a leading-slash request target, or an absolute HTTP(S) URL. Returns null for
 * a malformed or unroutable path. Query and fragment are excluded. Decoding is per segment;
 * embedded delimiters and percent signs stay escaped in this identity. Handler params
 * contain their decoded values.
 */
export function routedPath(request: Request | string): string | null
{
    if (typeof request === 'string' && !request.startsWith('/'))
    {
        const authority = HTTP_AUTHORITY.exec(request);
        if (authority === null || !URL.canParse(authority[0]))
        {
            return null;
        }
    }
    return pathIdentity(pathnameOf(typeof request === 'string' ? request : request.url));
}
