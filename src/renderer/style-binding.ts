// ============================================================================
// QUANTUM FRAMEWORK — Style Binding
// ============================================================================
//
// styleMap() converts an object of CSS properties into a reactive
// inline style string.
//
// WITHOUT styleMap:
//   h('div', {
//     style: () => `color: ${textColor()}; font-size: ${fontSize()}px; opacity: ${isVisible() ? 1 : 0}`,
//   })
//   // String concatenation nightmare. Missing semicolons break everything.
//
// WITH styleMap:
//   h('div', {
//     style: styleMap({
//       color: textColor,
//       'font-size': () => `${fontSize()}px`,
//       opacity: () => isVisible() ? 1 : 0,
//     }),
//   })
//   // Clean object syntax. Each property is independently reactive.
//
// ============================================================================

/**
 * A style value. Can be:
 *   - string/number → static value
 *   - () => string/number → reactive value
 *   - null/undefined → property is removed
 */
type StyleValue = string | number | null | undefined | (() => string | number | null | undefined);

/**
 * An object mapping CSS property names to values.
 *
 * Property names can use either:
 *   - kebab-case: 'font-size', 'background-color'
 *   - camelCase: 'fontSize', 'backgroundColor'
 *
 * @example
 * ```ts
 * {
 *     color: 'red',
 *     'font-size': '16px',
 *     opacity: () => isVisible() ? 1 : 0,
 *     backgroundColor: theme,
 * }
 * ```
 */
export type StyleObject = Record<string, StyleValue>;

/**
 * Converts a style object into a reactive inline style string getter.
 *
 * Returns a function that can be passed as the `style` prop to h().
 * The function re-evaluates whenever reactive values change.
 *
 * @param styles - An object mapping CSS property names to values
 *
 * @returns A getter function that returns the resolved style string
 *
 * @example
 * ```ts
 * const [color, setColor] = createSignal('blue');
 * const [size, setSize] = createSignal(16);
 *
 * h('p', {
 *   style: styleMap({
 *     color: color,
 *     'font-size': () => `${size()}px`,
 *     'font-weight': 'bold',
 *   }),
 * }, 'Styled text');
 *
 * // Renders: <p style="color: blue; font-size: 16px; font-weight: bold;">
 *
 * setColor('red');
 * // Updates: <p style="color: red; font-size: 16px; font-weight: bold;">
 * ```
 *
 * @example
 * ```ts
 * // Conditional styles — null/undefined removes the property
 * h('div', {
 *   style: styleMap({
 *     display: () => isHidden() ? 'none' : null,
 *     opacity: () => isLoading() ? 0.5 : 1,
 *     transform: () => isExpanded() ? 'scale(1.1)' : 'scale(1)',
 *   }),
 * });
 * ```
 *
 * @example
 * ```ts
 * // camelCase works too
 * h('div', {
 *   style: styleMap({
 *     backgroundColor: theme,
 *     borderRadius: '8px',
 *     boxShadow: () => isElevated() ? '0 4px 12px rgba(0,0,0,0.3)' : 'none',
 *   }),
 * });
 * ```
 */
export function styleMap(styles: StyleObject): () => string
{
    return () =>
    {
        const parts: string[] = [];

        for (const [property, value] of Object.entries(styles))
        {
            const resolved = typeof value === 'function' ? value() : value;

            if (resolved === null || resolved === undefined)
            {
                continue;
            }

            const cssProperty = property.replace(
                /[A-Z]/g,
                (match) => `-${ match.toLowerCase() }`
            );

            parts.push(`${ cssProperty }: ${ resolved }`);
        }

        return parts.join('; ');
    };
}
