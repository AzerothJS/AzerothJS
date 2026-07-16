/**
 * MODULE: router/path-pattern
 *
 * Compiles a route pattern (`/users/:id`) into a matcher that tests URL pathnames and extracts
 * params, plus a builder that substitutes params back into a URL. Supported: static segments
 * (/users), params (/users/:id -> params.id = '42'), and a trailing wildcard (/docs/*path ->
 * params.path = 'a/b/c'). Not in v1 (each addable without breaking the API): optional segments,
 * regex constraints, multiple wildcards.
 *
 * This module knows nothing about nested routes - the router flattens its tree into leaf full
 * patterns and uses this only on those, keeping matching purely declarative. Encoding: match()
 * URL-decodes params and compares static segments after decoding both sides; build() URL-encodes
 * param values but leaves wildcard values unencoded (they are already path-shaped, so encoding
 * would double-escape their slashes). The segment-parsing internals below carry their own comments.
 */

import type { Params } from './types.ts';

/**
 * One unit of a compiled pattern.
 *
 * @internal
 */
type Segment =
    | { kind: 'static'; value: string }
    | { kind: 'param'; name: string }
    | { kind: 'wildcard'; name: string };

/**
 * The result of `compilePath()`.
 *
 * Reusable across many `match`/`build` calls. Holds the parsed segment list
 * internally so we don't re-parse the pattern on every match.
 */
export interface PathMatcher
{
    /** The original pattern string, kept for debugging and error messages. */
    readonly pattern: string;

    /**
     * Tests `pathname` against the compiled pattern.
     *
     * Returns the extracted params on success, or `null` on mismatch. Trailing
     * slashes on the path are normalized, so `/users` and `/users/` match the
     * same pattern.
     *
     * @param pathname - URL pathname (no query, no hash)
     *
     * @example
     * ```ts
     * const m = compilePath('/users/:id');
     * m.match('/users/42'); // -> { params: { id: '42' } }
     * m.match('/posts/42'); // -> null
     * ```
     */
    match(pathname: string): { params: Params } | null;

    /**
     * Substitutes params back into the pattern to produce a concrete URL
     * pathname.
     *
     * Param values are URL-encoded; wildcard values are inserted verbatim,
     * since they may legitimately contain `/`. Throws if any param is missing
     * from `params`.
     *
     * @param params - Map of param name to value. Extra keys are ignored.
     *
     * @example
     * ```ts
     * const m = compilePath('/users/:id');
     * m.build({ id: '42' });          // -> '/users/42'
     * m.build({ id: 'a b' });         // -> '/users/a%20b' (encoded)
     * ```
     */
    build(params: Params): string;
}

/**
 * compilePath
 *
 * PURPOSE:
 * Compiles a route pattern into a reusable, stateless {@link PathMatcher}: match a pathname to
 * params, or build a pathname from params.
 *
 * WHY IT EXISTS:
 * The router must test pathnames, extract params, and reconstruct URLs from a declarative pattern.
 * Parsing the pattern once into a matcher (rather than re-parsing on every match) keeps routing
 * cheap, and a regex-free segment walk keeps the matching predictable and easy to reason about.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; createRouter compiles each flattened leaf full-path with this at construction.
 *
 * INPUT CONTRACT:
 * - pattern: a route pattern of static, `:param`, and a trailing `*wildcard` segments.
 *
 * OUTPUT CONTRACT:
 * - A PathMatcher with match(pathname) -> { params } | null and build(params) -> pathname. The
 *   matcher is stateless and reusable across any number of calls.
 *
 * WHY THIS DESIGN:
 * The pattern is parsed once into a segment list; matching is a linear walk (no regex), trailing
 * slashes are normalized so /users and /users/ match the same pattern, and a wildcard must be the
 * last segment (validated at compile time) so matching needs no suffix bookkeeping.
 *
 * WHEN TO USE:
 * To match or build a single route pattern (the router does this for every leaf).
 *
 * WHEN NOT TO USE:
 * For nested-route resolution - the router flattens the tree first and only calls this on leaves.
 *
 * EDGE CASES:
 * - The empty pattern matches only '' and '/'.
 * - Malformed %-escapes decode to the raw value rather than throwing (safeDecode).
 * - build() throws if a required param/wildcard is missing.
 *
 * PERFORMANCE NOTES:
 * Parse cost is paid once at compile; match and build are O(segments) with no regex.
 *
 * DEVELOPER WARNING:
 * Only a TRAILING wildcard is supported (a wildcard elsewhere throws at compile). build() does NOT
 * encode wildcard values (they are path-shaped) - encode unsafe characters within them yourself.
 *
 * @param pattern - The route pattern, e.g. `/users/:id`.
 * @returns A reusable {@link PathMatcher}.
 * @example
 * const m = compilePath('/users/:id/posts/:slug');
 * m.match('/users/42/posts/hello');           // { params: { id: '42', slug: 'hello' } }
 * m.build({ id: '42', slug: 'hello world' }); // '/users/42/posts/hello%20world'
 * compilePath('/docs/*path').match('/docs/a/b'); // { params: { path: 'a/b' } }
 */
export function compilePath(pattern: string): PathMatcher
{
    const segments = parsePattern(pattern);

    return {
        pattern,
        match(pathname: string): { params: Params } | null
        {
            return matchSegments(segments, pathname);
        },
        build(params: Params): string
        {
            return buildFromSegments(segments, params, pattern);
        }
    };
}

/**
 * Splits a pattern string into structured segments.
 *
 * Validates that wildcard segments are last: multiple wildcards, or a wildcard
 * followed by other segments, is ambiguous and unsupported.
 *
 * @internal
 */
function parsePattern(pattern: string): Segment[]
{
    const parts = splitPath(pattern);
    const segments: Segment[] = [];
    // Track param/wildcard names so a duplicate (`/users/:id/:id`) is a clear compile error rather than
    // silently collapsing - the second occurrence would overwrite the first at match time (data loss).
    const names = new Set<string>();

    for (let i = 0; i < parts.length; i++)
    {
        const part = parts[i];
        if (part === undefined)
        {
            continue; // splitPath returns a dense array; satisfies the indexed-access check
        }

        if (part.startsWith(':') || part.startsWith('*'))
        {
            const isWildcard = part.startsWith('*');
            const name = part.slice(1);
            if (name.length === 0)
            {
                throw new Error(
                    `Invalid pattern '${ pattern }': ${ isWildcard ? 'wildcard' : 'param' } segment ` +
                    `'${ part[0] }' has no name`
                );
            }
            if (names.has(name))
            {
                throw new Error(`Invalid pattern '${ pattern }': duplicate parameter name ':${ name }'`);
            }
            names.add(name);
            if (isWildcard)
            {
                if (i !== parts.length - 1)
                {
                    throw new Error(`Invalid pattern '${ pattern }': wildcard segment must be last`);
                }
                segments.push({ kind: 'wildcard', name });
            }
            else
            {
                segments.push({ kind: 'param', name });
            }
            continue;
        }

        segments.push({ kind: 'static', value: part });
    }

    return segments;
}

/**
 * Tries to match a pre-parsed segment list against a path.
 *
 * @internal
 */
function matchSegments(segments: Segment[], pathname: string): { params: Params } | null
{
    const pathParts = splitPath(pathname);
    const params: Params = {};

    let pi = 0; // path index
    for (let si = 0; si < segments.length; si++)
    {
        const seg = segments[si];
        if (seg === undefined)
        {
            continue; // parsePattern builds a dense array; satisfies the indexed-access check
        }

        if (seg.kind === 'wildcard')
        {
            // Wildcard consumes the rest of the path verbatim. Each piece is
            // decoded individually so the joined result has decoded values but
            // keeps the slashes.
            const rest = pathParts.slice(pi).map(safeDecode).join('/');
            params[seg.name] = rest;
            return { params };
        }

        // Non-wildcard segments need a corresponding path part.
        if (pi >= pathParts.length)
        {
            return null;
        }

        const part = pathParts[pi];
        if (part === undefined)
        {
            return null; // pi < pathParts.length was just checked; unreachable in practice
        }

        if (seg.kind === 'param')
        {
            params[seg.name] = safeDecode(part);
        }
        else // static
        {
            if (safeDecode(part) !== safeDecode(seg.value))
            {
                return null;
            }
        }

        pi++;
    }

    // Ran out of pattern segments; must also be at the end of the path.
    if (pi !== pathParts.length)
    {
        return null;
    }

    return { params };
}

/**
 * Constructs a URL from a pattern and a params map.
 *
 * @internal
 */
function buildFromSegments(segments: Segment[], params: Params, pattern: string): string
{
    const out: string[] = [];

    for (const seg of segments)
    {
        if (seg.kind === 'static')
        {
            out.push(seg.value);
        }
        else if (seg.kind === 'param')
        {
            const value = params[seg.name];
            if (value === undefined)
            {
                throw new Error(`buildPath: missing required param '${ seg.name }' for pattern '${ pattern }'`);
            }
            out.push(encodeURIComponent(value));
        }
        else // wildcard
        {
            const value = params[seg.name];
            if (value === undefined)
            {
                throw new Error(`buildPath: missing required wildcard '${ seg.name }' for pattern '${ pattern }'`);
            }
            // Wildcards are path-shaped already, so don't re-encode the
            // slashes. We trust the caller to URL-encode any unsafe characters
            // within each segment beforehand.
            out.push(value);
        }
    }

    // Re-add the leading slash unless the pattern is genuinely empty (the index
    // pattern), in which case we return ''.
    if (out.length === 0)
    {
        return '';
    }
    return '/' + out.join('/');
}

/**
 * Normalizes a pathname or pattern into an array of segments.
 *
 * - leading and trailing `/` are stripped
 * - `''` and `'/'` both produce `[]`
 * - intermediate empty segments (from `//`) are kept as empty strings so
 *   `parsePattern` can flag them, though in practice no part of the system
 *   produces `//`.
 *
 * @internal
 */
function splitPath(input: string): string[]
{
    if (input.length === 0 || input === '/')
    {
        return [];
    }

    let s = input;
    if (s.startsWith('/'))
    {
        s = s.slice(1);
    }
    if (s.endsWith('/'))
    {
        s = s.slice(0, -1);
    }
    if (s.length === 0)
    {
        return [];
    }

    return s.split('/');
}

/**
 * Decodes a URL-encoded segment, falling back to the raw value
 * when the input is malformed.
 *
 * `decodeURIComponent` throws on invalid escape sequences (for
 * example `%E0%A4%A`). Treating those as opaque strings is more
 * forgiving than crashing the whole match.
 *
 * @internal
 */
function safeDecode(value: string): string
{
    try
    {
        return decodeURIComponent(value);
    }
    catch
    {
        return value;
    }
}
