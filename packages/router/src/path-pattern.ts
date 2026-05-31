// ============================================================================
// AZEROTHJS — Path Pattern Matcher
// ============================================================================
//
// Compiles a route pattern (`/users/:id`) into a matcher that
// accepts URL pathnames and extracts params, plus a builder that
// substitutes params back to produce a URL.
//
// SUPPORTED SYNTAX:
//
//   Static segments     /users
//   Param segments      /users/:id          → params.id = '42'
//   Wildcard segments   /docs/*path         → params.path = 'a/b/c'
//
// EXPLICITLY NOT SUPPORTED (v1):
//
//   Optional segments    /users/:id?        — adds matcher branching
//   Regex constraints    /users/:id(\\d+)   — adds parser complexity
//   Multiple wildcards   /a/*x/b/*y         — ambiguous; not useful
//
//   These can be added later without breaking the v1 API.
//
// NESTED ROUTE NOTE:
//
//   This module knows NOTHING about nested routes. The router
//   flattens its tree into "leaf full patterns" at creation time
//   and uses this module only on those leaf patterns. That keeps
//   matching purely declarative — no special "remaining suffix"
//   bookkeeping inside the matcher.
//
// ENCODING:
//
//   match()  — param values are URL-decoded; static segments are
//              compared after decoding both sides (the user's
//              pattern is canonical, but URLs in the wild may be
//              encoded).
//   build()  — param values are URL-encoded so they can be safely
//              dropped into a URL. Wildcard values are NOT encoded
//              (they're already path-shaped — encoding would
//              double-escape any slashes).
//
// ============================================================================

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
 * Re-usable across many `match`/`build` calls. Holds the parsed
 * segment list internally so we don't re-parse the pattern on
 * every match.
 */
export interface PathMatcher
{
    /** The original pattern string, kept for debugging and error messages. */
    readonly pattern: string;

    /**
     * Tests `pathname` against the compiled pattern.
     *
     * Returns the extracted params on success, or `null` on
     * mismatch. Trailing slashes on the path are normalized (so
     * `/users` and `/users/` match the same pattern).
     *
     * @param pathname - URL pathname (no query, no hash)
     */
    match(pathname: string): { params: Params } | null;

    /**
     * Substitutes params back into the pattern to produce a
     * concrete URL pathname.
     *
     * Param values are URL-encoded; wildcard values are inserted
     * verbatim (since they may legitimately contain `/`).
     *
     * Throws if any param is missing from `params`.
     *
     * @param params - Map of param name → value. Extra keys are ignored.
     */
    build(params: Params): string;
}

/**
 * Compiles a route pattern into a matcher.
 *
 * The matcher returned is stateless and may be reused across
 * any number of match/build calls.
 *
 * @param pattern - The route pattern, e.g. `/users/:id`
 *
 * @returns A `PathMatcher` for the given pattern
 *
 * @example
 * ```ts
 * const m = compilePath('/users/:id/posts/:slug');
 *
 * m.match('/users/42/posts/hello');
 * // → { params: { id: '42', slug: 'hello' } }
 *
 * m.match('/users/42');
 * // → null
 *
 * m.build({ id: '42', slug: 'hello world' });
 * // → '/users/42/posts/hello%20world'
 * ```
 *
 * @example
 * ```ts
 * // Wildcard captures the rest of the path
 * const docs = compilePath('/docs/*path');
 *
 * docs.match('/docs/intro/install');
 * // → { params: { path: 'intro/install' } }
 *
 * docs.build({ path: 'intro/install' });
 * // → '/docs/intro/install'
 * ```
 *
 * @example
 * ```ts
 * // Empty pattern matches only the empty/root path
 * const index = compilePath('');
 *
 * index.match('');     // → { params: {} }
 * index.match('/');    // → { params: {} }
 * index.match('/foo'); // → null
 * ```
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
 * Validates that wildcard segments are last — multiple wildcards
 * or a wildcard followed by other segments is ambiguous and
 * unsupported.
 *
 * @internal
 */
function parsePattern(pattern: string): Segment[]
{
    const parts = splitPath(pattern);
    const segments: Segment[] = [];

    for (let i = 0; i < parts.length; i++)
    {
        const part = parts[i];

        if (part.startsWith(':'))
        {
            const name = part.slice(1);
            if (name.length === 0)
            {
                throw new Error(`Invalid pattern '${ pattern }': param segment ':' has no name`);
            }
            segments.push({ kind: 'param', name });
            continue;
        }

        if (part.startsWith('*'))
        {
            const name = part.slice(1);
            if (name.length === 0)
            {
                throw new Error(`Invalid pattern '${ pattern }': wildcard segment '*' has no name`);
            }
            if (i !== parts.length - 1)
            {
                throw new Error(`Invalid pattern '${ pattern }': wildcard segment must be last`);
            }
            segments.push({ kind: 'wildcard', name });
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

        if (seg.kind === 'wildcard')
        {
            // Wildcard consumes the rest of the path verbatim.
            // Each piece is decoded individually so the joined
            // result has decoded values but keeps the slashes.
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

    // Ran out of pattern segments — must also be at end of path.
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
            // Wildcards are path-shaped already — don't re-encode
            // the slashes. We trust the caller to URL-encode any
            // unsafe characters within each segment beforehand.
            out.push(value);
        }
    }

    // Re-add the leading slash unless the pattern is genuinely
    // empty (the index pattern), in which case we return ''.
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
 * - intermediate empty segments (from `//`) are kept as empty
 *   strings so `parsePattern` can flag them — although in
 *   practice no part of the system produces `//`.
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
