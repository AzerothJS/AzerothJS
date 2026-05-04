// ============================================================================
// AZEROTHJS — Query String Parsing & Serialization
// ============================================================================
//
// Two pure functions for converting between a `?key=value` URL
// fragment and our `Query` shape (which collapses repeated keys
// into arrays).
//
//   '?page=2&sort=desc'      ⇄  { page: '2', sort: 'desc' }
//   '?tags=a&tags=b'         ⇄  { tags: ['a', 'b'] }
//   '?flag'                  ⇄  { flag: '' }   (no value: empty string)
//
// We delegate URL-encoding and -decoding to the platform's
// `URLSearchParams`. Two things it doesn't do for us:
//
//   1. Coalesce repeated keys into arrays — we group them in
//      `parseQuery` after the platform has decoded values.
//   2. Strip a leading `?` from input — we do it explicitly so
//      callers can pass either form interchangeably.
//
// SHAPE CONTRACT:
//
//   Single occurrence of a key  →  string value
//   Two or more occurrences     →  string[] value (insertion order)
//   No-value or empty value     →  ''
//
// LEADING `?`:
//
//   parseQuery accepts and discards a leading `?` for caller
//   convenience.
//   stringifyQuery NEVER emits a leading `?` — the caller is
//   responsible for adding it when concatenating to a path. This
//   keeps the empty case clean: `stringifyQuery({})` returns `''`,
//   not `'?'`.
//
// ============================================================================

import type { Query } from './types.ts';

/**
 * Parses a URL query string into a `Query` object.
 *
 * Single occurrences of a key produce a string value; repeated
 * occurrences produce a string-array value in insertion order.
 * Keys with no value (`?flag`) and empty values (`?flag=`) both
 * produce `''`.
 *
 * @param search - Query string with or without leading `?`. The
 *                 empty string and `'?'` both produce `{}`.
 *
 * @returns The parsed `Query` object
 *
 * @example
 * ```ts
 * parseQuery('?page=2&sort=desc');
 * // → { page: '2', sort: 'desc' }
 *
 * parseQuery('tags=a&tags=b&tags=c');
 * // → { tags: ['a', 'b', 'c'] }
 *
 * parseQuery('?name=John%20Doe');
 * // → { name: 'John Doe' }
 *
 * parseQuery('?flag');
 * // → { flag: '' }
 *
 * parseQuery('');
 * // → {}
 * ```
 */
export function parseQuery(search: string): Query
{
    // Tolerate either form so callers don't have to remember.
    let raw = search;
    if (raw.startsWith('?')) raw = raw.slice(1);
    if (raw.length === 0) return {};

    const params = new URLSearchParams(raw);
    const result: Query = {};

    // Iterate unique keys and collapse repeats into arrays.
    // `new Set(params.keys())` deduplicates while preserving the
    // insertion order of first appearance, which matches user
    // expectations when displaying or re-serializing.
    for (const key of new Set(params.keys()))
    {
        const all = params.getAll(key);
        result[key] = all.length === 1 ? all[0] : all;
    }

    return result;
}

/**
 * Serializes a `Query` object to a URL query string.
 *
 * Array values produce repeated keys (`?tags=a&tags=b`). The
 * returned string has NO leading `?` — concatenate one yourself
 * when joining onto a path. This makes the empty case clean:
 * `stringifyQuery({})` returns `''`, not `'?'`.
 *
 * Special characters are URL-encoded. An empty array value is
 * dropped (the key does not appear in the output).
 *
 * @param query - The query object to serialize
 *
 * @returns The serialized query string (no leading `?`)
 *
 * @example
 * ```ts
 * stringifyQuery({ page: '2', sort: 'desc' });
 * // → 'page=2&sort=desc'
 *
 * stringifyQuery({ tags: ['a', 'b'] });
 * // → 'tags=a&tags=b'
 *
 * stringifyQuery({ name: 'John Doe' });
 * // → 'name=John+Doe'   (URLSearchParams encodes space as '+')
 *
 * stringifyQuery({});
 * // → ''
 *
 * // Round-trip — values come back identically
 * const original = { tags: ['a', 'b'], page: '2' };
 * parseQuery(stringifyQuery(original));
 * // → { tags: ['a', 'b'], page: '2' }
 * ```
 */
export function stringifyQuery(query: Query): string
{
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query))
    {
        if (Array.isArray(value))
        {
            // Empty array → key does not appear in output.
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
