/**
 * MODULE: router/query
 *
 * Two pure functions converting between a `?key=value` URL fragment and the framework's `Query`
 * shape, which collapses repeated keys into arrays:
 *   '?page=2&sort=desc' <-> { page: '2', sort: 'desc' }
 *   '?tags=a&tags=b'    <-> { tags: ['a', 'b'] }
 *   '?flag'             <-> { flag: '' }   (no value -> empty string)
 *
 * URL en/decoding is delegated to URLSearchParams; this module adds the two things it does not do:
 * coalesce repeated keys into arrays (in parseQuery, after decoding) and tolerate a leading `?`.
 * Shape contract: one occurrence -> string; two or more -> string[] (insertion order); no/empty
 * value -> ''. parseQuery accepts and discards a leading `?`; stringifyQuery never emits one (the
 * caller adds it), keeping the empty case clean (stringifyQuery({}) === '').
 */

import type { Query } from './types.ts';

/**
 * parseQuery
 *
 * PURPOSE:
 * Parses a URL query string into a {@link Query} object, collapsing repeated keys into arrays.
 *
 * WHY IT EXISTS:
 * URLSearchParams decodes values but exposes repeated keys awkwardly and does not give the
 * array-or-string shape the router uses for params/query memoization. parseQuery produces that
 * canonical shape in one call and tolerates input with or without a leading `?`.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; pure helper used to build RouteLocation.query and by useQuery.
 *
 * INPUT CONTRACT:
 * - search: a query string with or without a leading `?`. '' and '?' both yield {}.
 *
 * OUTPUT CONTRACT:
 * - A Query where a single-occurrence key is a string, a repeated key is a string[] in insertion
 *   order, and a no-value/empty key is ''.
 *
 * WHY THIS DESIGN:
 * Repeated keys are grouped via `new Set(params.keys())`, which dedupes while preserving first-
 * appearance order - matching what users expect when displaying or re-serializing. Delegating
 * decoding to URLSearchParams keeps escaping correct and standard.
 *
 * WHEN TO USE:
 * To turn a location.search into structured query data.
 *
 * WHEN NOT TO USE:
 * For path params (those come from the route matcher), or for parsing a full URL (split it first).
 *
 * EDGE CASES:
 * - '' / '?' -> {}. '?flag' and '?flag=' both -> { flag: '' }.
 * - Order is preserved by first appearance of each key.
 *
 * PERFORMANCE NOTES:
 * O(query length); one URLSearchParams pass plus a getAll per distinct key.
 *
 * DEVELOPER WARNING:
 * A key that appears once is a string, not a one-element array - handle both shapes (or use the
 * useQuery memo, which compares both).
 *
 * @param search - Query string with or without leading `?`.
 * @returns The parsed {@link Query}.
 * @see {@link stringifyQuery}
 * @example
 * parseQuery('?page=2&sort=desc');    // { page: '2', sort: 'desc' }
 * parseQuery('tags=a&tags=b&tags=c'); // { tags: ['a', 'b', 'c'] }
 * parseQuery('?flag');                // { flag: '' }
 */
export function parseQuery(search: string): Query
{
    // Tolerate either form so callers don't have to remember.
    let raw = search;
    if (raw.startsWith('?'))
    {
        raw = raw.slice(1);
    }
    if (raw.length === 0)
    {
        return {};
    }

    const params = new URLSearchParams(raw);
    const result: Query = {};

    // Collapse repeated keys into arrays. new Set(params.keys()) dedupes while preserving the
    // insertion order of first appearance, matching user expectations on display/re-serialize.
    for (const key of new Set(params.keys()))
    {
        const all = params.getAll(key);
        result[key] = all.length === 1 ? all[0] : all;
    }

    return result;
}

/**
 * stringifyQuery
 *
 * PURPOSE:
 * Serializes a {@link Query} object to a URL query string (array values -> repeated keys), with no
 * leading `?`.
 *
 * WHY IT EXISTS:
 * The inverse of parseQuery, needed to build navigation targets and <Link> hrefs from structured
 * query data, with consistent encoding and the same array<->repeated-key contract.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; pure helper used by targetToFullPath when building a URL from a structured target.
 *
 * INPUT CONTRACT:
 * - query: a Query; values are strings or string[] (an empty array drops the key).
 *
 * OUTPUT CONTRACT:
 * - The serialized query string with NO leading `?` (the caller adds it when joining to a path),
 *   so stringifyQuery({}) === ''.
 *
 * WHY THIS DESIGN:
 * Omitting the leading `?` keeps the empty case clean ('' not '?') and lets the caller decide
 * placement. URLSearchParams handles encoding; array values append repeated keys to round-trip
 * with parseQuery.
 *
 * WHEN TO USE:
 * To build the search portion of a URL from query data.
 *
 * WHEN NOT TO USE:
 * When you already hold a raw search string (pass it through).
 *
 * EDGE CASES:
 * - {} -> ''. An empty-array value omits its key. Spaces encode as '+'.
 *
 * PERFORMANCE NOTES:
 * O(number of entries); one URLSearchParams build.
 *
 * @param query - The {@link Query} to serialize.
 * @returns The serialized query string (no leading `?`).
 * @see {@link parseQuery}
 * @example
 * stringifyQuery({ page: '2', sort: 'desc' }); // 'page=2&sort=desc'
 * stringifyQuery({ tags: ['a', 'b'] });        // 'tags=a&tags=b'
 * stringifyQuery({});                          // ''
 */
export function stringifyQuery(query: Query): string
{
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query))
    {
        if (Array.isArray(value))
        {
            // Empty array: key does not appear in output.
            for (const item of value)
            {
                params.append(key, item);
            }
        }
        else
        {
            params.append(key, value);
        }
    }

    return params.toString();
}
