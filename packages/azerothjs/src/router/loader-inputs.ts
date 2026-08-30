/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * THE loader argument, built in ONE place - and the object a level's cache key is derived
 * FROM, so the two cannot skew.
 *
 * The rule both halves answer to lives in {@link declaredQuery}: a level's key must never
 * be COARSER than the argument its loader receives, because a navigation that leaves the
 * key unchanged starts no fetch, so a value produced from wider inputs is then served for
 * every URL that shares the key.
 *
 * Params were the second axis to violate it. Three different answers to "which params
 * belong to this level" coexisted - own-path-only, the prefix slice, and the whole matched
 * chain - and the key used the prefix while the loader was handed the chain. A layout that
 * read a descendant's param therefore pinned to the first value it ever saw and kept
 * serving it under every sibling URL. The prefix slice is the level's honest identity: the
 * params its own pattern and its ancestors' bind, never a descendant's.
 *
 * A layout that wants a descendant's param is not asking for a fetch input - it cannot key
 * on one. It wants a RENDER input, which `useParams()` already gives reactively, or a
 * descendant level's data, which `useLoader(handle)` already resolves.
 */

import type { Params, Query, Route, SearchSchemaLike } from './types.ts';
import { declaredQuery } from './query.ts';
import { paramNamesOf } from './path-pattern.ts';

/** What one level's loader is handed. */
export interface LoaderInputs
{
    params: Params;
    query: Query;
}

/**
 * The params bound at or above `level`: this route's own pattern and its ancestors',
 * never a descendant's. Exported so the key and the argument read one definition.
 */
export function prefixParams(matched: readonly Route[], level: number, params: Params): Params
{
    const prefix: Params = {};
    for (let i = 0; i <= level; i++)
    {
        const above = matched[i];
        if (above === undefined)
        {
            continue;
        }
        for (const name of paramNamesOf(above.path))
        {
            const value = params[name];
            if (value !== undefined)
            {
                prefix[name] = value;
            }
        }
    }
    return prefix;
}

/**
 * Builds one level's loader argument. EVERY path that invokes a loader - the client's live
 * navigation, its seed adoption, its revalidate, and the server handoff - goes through
 * here, so a fourth path cannot reintroduce the skew by forgetting a rule.
 *
 * `onInvalid` is injected rather than owned; see {@link declaredQuery} for why the server
 * passes nothing.
 */
export function loaderInputs(
    matched: readonly Route[],
    level: number,
    params: Params,
    parsedSearch: Query,
    onInvalid?: (errors: Record<string, string>) => void
): LoaderInputs
{
    const route = matched[level];
    const schema: SearchSchemaLike | undefined = route?.search;
    return {
        params: prefixParams(matched, level, params),
        query: declaredQuery(schema, parsedSearch, onInvalid)
    };
}
