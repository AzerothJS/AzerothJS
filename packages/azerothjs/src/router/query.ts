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

import type { Query, SearchSchemaLike } from './types.ts';
import { DEV } from '../reactivity/dev.ts';

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

/**
 * THE DECLARED QUERY a level's loader receives - the ONE definition of it, applied
 * identically by the client router, the SSR handoff, and `useSearch`.
 *
 * THE INVARIANT, one-directional: **a level's cache key must never be COARSER than the
 * argument its loader receives.** The client skips the fetch entirely when a navigation
 * leaves the level key unchanged, so a value produced from inputs WIDER than its key is
 * served, unfetched, for every other URL sharing that key. A key FINER than the argument
 * is merely a lost cache hit, which is why the schema-less case can key on the raw search
 * STRING while handing the loader the parsed object. Exactness is the goal where it is
 * cheap; never-coarser is the rule, and passing a raw query alongside a declared key is
 * the one combination that violates it.
 *
 * A route with no schema declares nothing, so its whole parsed query IS its declared
 * input, and the key widens to match - the two stay in step either way.
 *
 * `onInvalid` is INJECTED rather than owned: a failed parse is worth reporting in an
 * editor and on a client, but this runs on the SSR path too, where the input is a
 * request an attacker controls and a console call would be per-request log amplification.
 * The caller that has a safe place to report passes one; the server passes nothing.
 */
export function declaredQuery(
    schema: SearchSchemaLike | undefined,
    raw: Query,
    onInvalid?: (errors: Record<string, string>) => void
): Query
{
    if (schema === undefined)
    {
        return raw;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.ok)
    {
        return parsed.value as Query;
    }
    onInvalid?.(parsed.errors ?? {});
    return {};
}

/** @internal One report per (schema, search string), so a changing URL cannot spam the console. */
const warnedSearch = new WeakMap<SearchSchemaLike, string>();

/**
 * Reports a query that failed its schema, for the CLIENT doors only.
 *
 * Deliberately not called from the SSR path, for the reason {@link declaredQuery} gives: there the
 * query is attacker-controlled and a console call per request is log amplification. Shared by
 * `useSearch` and the loader key so the same bad query cannot be loud through one and mute through
 * the other, and so both share the one throttle.
 */
export function reportInvalidSearch(schema: SearchSchemaLike, search: string, errors: Record<string, string>): void
{
    if (!DEV || warnedSearch.get(schema) === search)
    {
        return;
    }
    warnedSearch.set(schema, search);
    console.warn(`[azerothjs/router] search params "${ search }" failed their schema; `
        + `degrading to {}. Fields: ${ Object.keys(errors).join(', ') }`);
}
