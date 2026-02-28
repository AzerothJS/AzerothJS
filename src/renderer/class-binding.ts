// ============================================================================
// QUANTUM FRAMEWORK — Class Binding
// ============================================================================
//
// classList() converts objects and arrays into CSS class strings.
// Works with reactive signals for dynamic class toggling.
//
// WITHOUT classList:
//   h('div', {
//     class: () => {
//       let c = 'btn';
//       if (isPrimary()) c += ' btn-primary';
//       if (isDisabled()) c += ' btn-disabled';
//       if (isLarge()) c += ' btn-lg';
//       return c;
//     },
//   })
//   // Ugly string concatenation. Error-prone.
//
// WITH classList:
//   h('div', {
//     class: classList({
//       'btn': true,
//       'btn-primary': isPrimary,
//       'btn-disabled': isDisabled,
//       'btn-lg': isLarge,
//     }),
//   })
//   // Clean, readable, reactive.
//
// ============================================================================

/**
 * A class binding value. Can be:
 *   - boolean → include/exclude the class
 *   - () => boolean → reactive include/exclude
 */
type ClassValue = boolean | (() => boolean);

/**
 * An object mapping class names to conditions.
 *
 * @example
 * ```ts
 * {
 *   'btn': true,              // always included
 *   'btn-primary': isPrimary, // reactive — included when isPrimary() is true
 *   'btn-disabled': false,    // never included
 * }
 * ```
 */
export type ClassObject = Record<string, ClassValue>;

/**
 * Converts a class binding object or array into a reactive
 * class string getter.
 *
 * Returns a function that can be passed as the `class` prop
 * to h(). The function re-evaluates whenever its reactive
 * conditions change (because it reads signals).
 *
 * @param classes - An object mapping class names to boolean conditions,
 *                  or an array of class names, objects, and getters.
 *
 * @returns A getter function that returns the resolved class string
 *
 * @example
 * ```ts
 * // Object syntax — key is class name, value is condition
 * const [isActive, setIsActive] = createSignal(false);
 * const [isLarge, setIsLarge] = createSignal(true);
 *
 * h('button', {
 *   class: classList({
 *     'btn': true,
 *     'btn-active': isActive,
 *     'btn-lg': isLarge,
 *   }),
 * }, 'Click me');
 *
 * // Renders: <button class="btn btn-lg">
 * setIsActive(true);
 * // Renders: <button class="btn btn-active btn-lg">
 * ```
 *
 * @example
 * ```ts
 * // Array syntax — mix strings, objects, and getters
 * h('div', {
 *   class: classList([
 *     'card',
 *     { 'card-hover': isHovered },
 *     { 'card-selected': isSelected },
 *   ]),
 * });
 * ```
 */
export function classList(classes: ClassObject | (string | ClassObject)[]): () => string
{
    return () =>
    {
        const result: string[] = [];

        if (Array.isArray(classes))
        {
            // Array syntax: ['card', { 'card-hover': isHovered }]
            for (const item of classes)
            {
                if (typeof item === 'string')
                {
                    result.push(item);
                }
                else
                {
                    resolveClassObject(item, result);
                }
            }
        }
        else
        {
            // Object syntax: { 'btn': true, 'btn-active': isActive }
            resolveClassObject(classes, result);
        }

        return result.join(' ');
    };
}

/**
 * Resolves a ClassObject into an array of active class names.
 *
 * @param obj - The class object to resolve
 * @param result - The array to push active class names into
 *
 * @internal
 */
function resolveClassObject(obj: ClassObject, result: string[]): void
{
    for (const [className, condition] of Object.entries(obj))
    {
        // Resolve the condition — it might be a boolean or a getter
        const isActive = typeof condition === 'function' ? condition() : condition;

        if (isActive)
        {
            result.push(className);
        }
    }
}
