/**
 * The one thunk-chain unwrap, behind every "call while it is a function" site.
 *
 * The compiler wraps each compound or call expression in `() =>`, and some of those
 * expressions already evaluate to a getter themselves: `classList()` returns `() => string`,
 * and a `{ p.title }` hole compiles to `() => (p.title)` where `p.title` is a getter too. A
 * single call can therefore surface an inner function whose SOURCE TEXT would otherwise
 * render into the DOM or the HTML string.
 *
 * Keeping it in one place is deliberate. Three copies of this loop once lived in the
 * renderer, the SSR serializer and the co-range component, and drift between them would
 * have meant a value that renders correctly in one mode and as source text in another.
 */

const MAX_THUNK_DEPTH = 16;

/**
 * Calls `value` while it is a function, returning the first non-function result, or the
 * function itself at the depth bound - which only a pathological getter that returns a
 * function forever can reach. Real chains are one or two deep.
 *
 * Reads happen in the CALLER's tracking context; wrap the whole call in untrack() for the
 * read-once semantics SSR needs.
 *
 * @internal
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
