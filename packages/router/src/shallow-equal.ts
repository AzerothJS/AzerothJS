/**
 * MODULE: router/shallow-equal
 *
 * One shallow record-equality check, shared by the router's match/params/query memos so a navigation
 * that produces an equivalent params/query object does not re-fire downstream effects. It handles both
 * single-string values (route params) and string|string[] values (query keys, where `?tags=a&tags=b`
 * parses to an array). The `a === b` and null checks are cheap defensive short-circuits.
 */

/** A record value: a single string (route params) or a repeated-key array (query keys). */
type RecordValue = string | string[];

/**
 * Shallow structural equality for a record of string / string[] values. Two records are equal when they
 * have the same keys and, per key, equal strings or element-wise-equal arrays (order-sensitive, matching
 * how `parseQuery` preserves insertion order). A string-vs-array mismatch is unequal. Route params are a
 * `Record<string, string>`, which is a subset of the accepted shape, so this serves them too.
 *
 * @example
 * ```ts
 * shallowEqualRecord({ id: '1' }, { id: '1' });             // true
 * shallowEqualRecord({ tags: ['a', 'b'] }, { tags: ['a'] }); // false
 * ```
 *
 * @internal
 */
export function shallowEqualRecord(
    a: Record<string, RecordValue>,
    b: Record<string, RecordValue>
): boolean
{
    if (a === b)
    {
        return true;
    }
    if (a == null || b == null)
    {
        return false;
    }

    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length)
    {
        return false;
    }

    for (const k of keysA)
    {
        const va = a[k];
        const vb = b[k];
        if (va === vb)
        {
            continue;
        }

        // Both arrays: compare element by element. Ordering matters, matching
        // how parseQuery preserves insertion order.
        if (Array.isArray(va) && Array.isArray(vb))
        {
            if (va.length !== vb.length)
            {
                return false;
            }
            for (let i = 0; i < va.length; i++)
            {
                if (va[i] !== vb[i])
                {
                    return false;
                }
            }
            continue;
        }

        // Mixed shape (one is array, the other isn't): not equal.
        return false;
    }

    return true;
}
