/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The params ONE route level is entitled to - the object its cache key is derived from, so
 * the key and the loader argument cannot skew.
 *
 * The rule this answers to lives in {@link declaredQuery}: a level key must never be COARSER
 * than the argument its loader receives, because a navigation that leaves the key unchanged
 * starts no fetch, so a value produced from wider inputs is then served for every URL sharing
 * that key.
 *
 * Params were the second axis to violate it. Three answers to "which params belong to this
 * level" coexisted - own-path-only, the prefix slice, and the whole matched chain - and the key
 * used the prefix while the loader was handed the chain. A layout that read a descendant param
 * therefore pinned to the first value it ever saw and kept serving it under every sibling URL.
 * The prefix slice is the level honest identity: the params its own pattern and its ancestors
 * bind, never a descendant.
 *
 * A layout that wants a descendant param is not asking for a fetch input - it cannot key on
 * one. It wants a RENDER input, which useParams() already gives reactively, or a descendant
 * level data, which useLoader(handle) already resolves.
 *
 * NOTE ON SHAPE: an earlier version also exported a loaderInputs() that claimed to be the one
 * funnel EVERY loader call goes through. It had no callers and was exported from no entry
 * point, so the claim was false the day it was written - the four call sites each build their
 * own argument and share only prefixParams. Removed rather than wired up, because a funnel with one
 * real user is a claim, not a constraint.
 */

import type { Params, Route } from './types.ts';
import { paramNamesOf } from './path-pattern.ts';

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
