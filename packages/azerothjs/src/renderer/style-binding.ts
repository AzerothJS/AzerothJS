/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CSS properties as a reactive inline-style getter, in place of manual concatenation where a
 * missing semicolon silently drops the rest of the declaration. Each property may be static
 * or a getter, so they update independently, and camelCase names become kebab-case.
 */

/** A static value, a getter, or null and undefined to omit the property entirely. */
type StyleValue = string | number | null | undefined | (() => string | number | null | undefined);

/**
 * An object mapping CSS property names (kebab-case OR camelCase) to {@link StyleValue}s.
 *
 * @example
 * { color: 'red', 'font-size': '16px', opacity: () => isVisible() ? 1 : 0, backgroundColor: theme }
 */
export type StyleObject = Record<string, StyleValue>;

/**
 * A CSS property name after kebab conversion: an optional `-` or `--` prefix for a vendor or
 * custom property, then a letter-led identifier. A name outside this shape - carrying spaces,
 * `;` or `:` - came from data and would open its own declaration inside the style attribute.
 */
const CSS_PROPERTY_NAME = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Rejects a style VALUE whose text could terminate its declaration and start another:
 * `10px; background: url(//evil)` is an exfiltration primitive.
 *
 * `;` is legal inside a quoted string or a url() body, which data URIs rely on, so those
 * regions are blanked before the test rather than the character being banned outright.
 */
function assertSafeStyleValue(property: string, resolved: string | number): void
{
    if (typeof resolved === 'number')
    {
        return;
    }

    const bare = resolved
        .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/url\([^)]*\)/gi, 'url()');
    if (/[;}]/.test(bare))
    {
        throw new Error(`azeroth: invalid style value for "${ property }" - a ';' or '}' outside a string or url() `
            + 'would start a new declaration inside the style attribute.');
    }
}

/**
 * Turns a {@link StyleObject} into a `() => string` getter for the `style` prop, recomputing
 * when a reactive value changes. camelCase keys become kebab-case.
 *
 * Pass the getter and do not call it when binding, or the style stops being reactive.
 *
 * A `null` or `undefined` value omits its property entirely, which is how a property is
 * conditionally removed. Numbers are stringified with NO implicit unit, so write
 * `` () => `${ n() }px` `` rather than `() => n()`.
 *
 * A property name outside the CSS identifier shape, or a value carrying `;` or `}` outside a
 * string or url() body, throws: either would open a second declaration inside the style
 * attribute, which is an injection.
 *
 * @param styles - CSS properties, in kebab-case or camelCase.
 * @returns A getter resolving to the inline-style string.
 * @throws {Error} On a data-shaped property name, or a value that could escape its
 *                 declaration.
 * @example
 * h('p', {
 *     style: styleMap({
 *         color,
 *         'font-size': () => `${ size() }px`,
 *         display: () => hidden() ? 'none' : null
 *     })
 * }, 'Styled');
 *
 * @see {@link classList} and {@link css} for static, reusable styling, which is preferable
 *      to heavy per-frame style churn.
 */
export function styleMap(styles: StyleObject): () => string
{
    return (): string =>
    {
        const parts: string[] = [];

        for (const [property, value] of Object.entries(styles))
        {
            const resolved = typeof value === 'function' ? value() : value;

            if (resolved === null || resolved === undefined)
            {
                continue;
            }

            // fontSize -> font-size
            const cssProperty = property.replace(
                /[A-Z]/g,
                (match) => `-${ match.toLowerCase() }`
            );

            // A data-driven property name is a declaration injection, refused the same way an
            // invalid attribute name is, identically on server and client.
            if (!CSS_PROPERTY_NAME.test(cssProperty))
            {
                throw new Error(`azeroth: invalid style property name ${ JSON.stringify(property) } - names must be `
                    + 'a letter-led identifier with an optional -/-- prefix.');
            }

            assertSafeStyleValue(cssProperty, resolved);

            parts.push(`${ cssProperty }: ${ resolved }`);
        }

        return parts.join('; ');
    };
}
