/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Conversion between a `?key=value` fragment and the framework's Query shape, which
 * collapses repeated keys into arrays:
 *
 *     '?page=2&sort=desc' <-> { page: '2', sort: 'desc' }
 *     '?tags=a&tags=b'    <-> { tags: ['a', 'b'] }
 *     '?flag'             <-> { flag: '' }
 *
 * Encoding and decoding are delegated to URLSearchParams. What this adds is the two things
 * it does not do: coalescing repeated keys into arrays, and tolerating a leading `?`.
 *
 * The shape contract is exact - one occurrence gives a string, two or more give an array in
 * insertion order, and a valueless key gives `''`. parseQuery accepts and discards a leading
 * `?`; stringifyQuery never emits one, leaving that to the caller, which keeps the empty case
 * clean.
 */

import type { Query } from './types.ts';

/**
 * Parses a query string into a {@link Query}, collapsing repeated keys into arrays in
 * first-appearance order.
 *
 * A key appearing ONCE is a string, not a one-element array, so handle both shapes - or read
 * through useQuery, whose memo compares both.
 *
 * The result has a NULL prototype, so a URL key like `__proto__` is plain data: it can
 * neither rewrite the object's prototype nor vanish from the parse.
 *
 * @param search - With or without a leading `?`. Both `''` and `'?'` give `{}`.
 * @returns The parsed query.
 * @example
 * parseQuery('?page=2&sort=desc');    // { page: '2', sort: 'desc' }
 * parseQuery('tags=a&tags=b&tags=c'); // { tags: ['a', 'b', 'c'] }
 * parseQuery('?flag');                // { flag: '' }
 *
 * @see {@link stringifyQuery}
 */
export function parseQuery(search: string): Query
{
    // Tolerate either form so callers don't have to remember.
    let raw = search;
    if (raw.startsWith('?'))
    {
        raw = raw.slice(1);
    }
    // Null-prototype result: assigning onto `{}` lets a `?__proto__=a&__proto__=b` URL
    // REPLACE the object's prototype (the repeated key parses to an array, which the
    // setter accepts) and silently drop a single `?__proto__=x` key. With no prototype
    // there is no setter: every parsed key becomes an own, enumerable property.
    if (raw.length === 0)
    {
        return Object.create(null) as Query;
    }

    const params = new URLSearchParams(raw);
    const result: Query = Object.create(null) as Query;

    // Collapse repeated keys into arrays. new Set(params.keys()) dedupes while preserving the
    // insertion order of first appearance, matching user expectations on display/re-serialize.
    for (const key of new Set(params.keys()))
    {
        const all = params.getAll(key);
        result[key] = all.length === 1 ? (all[0] ?? '') : all;
    }

    return result;
}

/**
 * Serializes a {@link Query} back to a query string, array values becoming repeated keys so
 * the round trip through {@link parseQuery} is exact.
 *
 * No leading `?` is emitted - the caller adds it when joining to a path - which is what keeps
 * the empty case `''` rather than `'?'`. An empty-array value drops its key, and spaces
 * encode as `+`.
 *
 * @param query - Values are strings or arrays of strings.
 * @returns The query string, with no leading `?`.
 * @example
 * stringifyQuery({ page: '2', sort: 'desc' }); // 'page=2&sort=desc'
 * stringifyQuery({ tags: ['a', 'b'] });        // 'tags=a&tags=b'
 * stringifyQuery({});                          // ''
 *
 * @see {@link parseQuery}
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
