/**
 * MODULE: reactivity/resolve-thunks (internal)
 *
 * THE thunk-chain unwrap - the one implementation behind every "call while it is a
 * function" site in the framework. The compiler wraps every compound/call attribute or
 * child expression in `() =>`, and some of those expressions ALREADY evaluate to a
 * getter (`classList()` returns `() => string`; a `{ p.title }` hole compiles to
 * `() => (p.title)` where `p.title` is itself a getter) - so a single call can surface
 * an inner function whose SOURCE TEXT would otherwise render into the DOM or the HTML
 * string. Unwrapping to a non-function value fixes that, everywhere, identically.
 *
 * Calls are PLAIN (tracked when run inside an effect; wrap the whole call in untrack()
 * for the SSR read-once semantics). The depth bound guards a pathological getter that
 * returns a function forever; real chains are one or two deep.
 *
 * Three copies of this loop once lived in renderer/h.ts, reactivity/ssr.ts, and
 * component/co-range.ts - drift between them would have meant "renders here,
 * source-text there". One implementation makes that class of bug impossible.
 */

/** @internal The unwrap depth bound; see the module header. */
const MAX_THUNK_DEPTH = 16;

/**
 * Calls `value` while it is a function (bounded), returning the first non-function
 * result. Reads happen in the CALLER's tracking context.
 *
 * @internal
 * @param value - A possibly-thunked value.
 * @returns The first non-function value reached (or the function itself at the bound).
 */
export function resolveThunks(value: unknown): unknown
{
    let resolved = value;
    let depth = 0;
    while (typeof resolved === 'function' && depth < MAX_THUNK_DEPTH)
    {
        resolved = (resolved as () => unknown)();
        depth++;
    }
    return resolved;
}
