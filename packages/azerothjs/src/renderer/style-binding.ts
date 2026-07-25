/**
 * MODULE: renderer/style-binding
 *
 * styleMap() converts an object of CSS properties into a reactive inline-style getter,
 * replacing fragile manual concatenation (where a missing semicolon silently drops the rest
 * of the declaration). Each property may be static or a getter, so properties update
 * independently; camelCase names are converted to kebab-case automatically.
 */

/**
 * A style value: a static string/number, a getter for reactivity, or null/undefined to omit
 * the property.
 */
type StyleValue = string | number | null | undefined | (() => string | number | null | undefined);

/**
 * An object mapping CSS property names (kebab-case OR camelCase) to {@link StyleValue}s.
 *
 * @example
 * { color: 'red', 'font-size': '16px', opacity: () => isVisible() ? 1 : 0, backgroundColor: theme }
 */
export type StyleObject = Record<string, StyleValue>;

/**
 * styleMap
 *
 * PURPOSE:
 * Turns a {@link StyleObject} into a `() => string` inline-style getter for the `style` prop,
 * recomputing when its reactive values change. camelCase keys become kebab-case;
 * null/undefined values drop their property.
 *
 * WHY IT EXISTS:
 * Hand-built style strings are brittle - one missing separator breaks the whole declaration,
 * and reactive recomputation must be wired manually. styleMap declares properties as an
 * object so separators are automatic and each property is independently reactive.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; an authoring helper. Returns a getter that h()'s attribute effect
 * unwraps (via resolveReactive), so reading a signal value tracks it.
 *
 * INPUT CONTRACT:
 * - styles: a StyleObject; values are strings/numbers, getters, or null/undefined.
 *
 * OUTPUT CONTRACT:
 * - Returns a `() => string` of `prop: value` pairs joined by `; `, with camelCase keys
 *   converted and null/undefined properties omitted.
 *
 * WHY THIS DESIGN:
 * Returning a getter keeps it reactive in h(); the object form makes properties addressable
 * and individually conditional, and the kebab-case conversion lets authors use JS-style
 * camelCase keys.
 *
 * WHEN TO USE:
 * For inline styles that depend on state (dynamic color/size/opacity/transform), or to toggle
 * a property off via null.
 *
 * WHEN NOT TO USE:
 * For static, reusable styling - prefer scoped classes via {@link css} and
 * {@link classList}. Heavy per-frame style churn is better done with a class swap.
 *
 * EDGE CASES:
 * - null/undefined value omits the property entirely (used to conditionally remove one).
 * - Numeric values are stringified as-is (no unit is added - write `() => `${ n() }px``).
 *
 * PERFORMANCE NOTES:
 * O(number of properties) per evaluation; runs only when a value signal changes (one
 * attribute effect in h()).
 *
 * DEVELOPER WARNING:
 * Pass the getter (`style: styleMap({...})`) - do not call it when binding, or it stops being
 * reactive. Remember numbers carry no implicit unit.
 *
 * @param styles - A {@link StyleObject}.
 * @returns A getter resolving to the inline-style string.
 * @see {@link classList}
 * @see {@link css}
 * @example
 * h('p', {
 *   style: styleMap({ color, 'font-size': () => `${ size() }px`, display: () => hidden() ? 'none' : null })
 * }, 'Styled');
 */
export function styleMap(styles: StyleObject): () => string
{
    return (): string =>
    {
        const parts: string[] = [];

        for (const [property, value] of Object.entries(styles))
        {
            const resolved = typeof value === 'function' ? value() : value;

            // null/undefined means "drop this property".
            if (resolved === null || resolved === undefined)
            {
                continue;
            }

            // fontSize -> font-size, backgroundColor -> background-color
            const cssProperty = property.replace(
                /[A-Z]/g,
                (match) => `-${ match.toLowerCase() }`
            );

            parts.push(`${ cssProperty }: ${ resolved }`);
        }

        return parts.join('; ');
    };
}
