// classList() converts objects and arrays into reactive CSS class-string
// getters, replacing error-prone manual concatenation.
//
// Without classList: hand-concatenate the class string, juggling spaces and
// branches.
//
//     class: () =>
//     {
//         let c = 'btn';
//         if (isPrimary()) c += ' btn-primary';
//         if (isDisabled()) c += ' btn-disabled';
//         return c; // a forgotten leading space silently merges two classes
//     }
//
// With classList: a condition map, where each value is a static boolean or a
// signal getter.
//
//     class: classList({
//         'btn': true,
//         'btn-primary': isPrimary,
//         'btn-disabled': isDisabled
//     }) // spacing is automatic; each class is independently reactive

/**
 * A class binding value. Can be:
 *   - boolean -> static include/exclude
 *   - () => boolean -> reactive include/exclude
 */
type ClassValue = boolean | (() => boolean);

/**
 * An object mapping class names to conditions.
 *
 * Each key is a CSS class name. Each value determines
 * whether that class is included.
 *
 * @example
 * ```ts
 * {
 *   'btn': true,              // always included
 *   'btn-primary': isPrimary, // reactive: signal getter
 *   'btn-disabled': false     // never included
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
 * @param classes - Object mapping class names to conditions,
 *                  or array of strings and objects.
 *
 * @returns A getter function that returns the resolved class string
 *
 * @example
 * ```ts
 * // Object syntax
 * const [isActive, setIsActive] = createSignal(false);
 * const [isLarge, setIsLarge] = createSignal(true);
 *
 * h('button', {
 *   class: classList({
 *     'btn': true,
 *     'btn-active': isActive,
 *     'btn-lg': isLarge
 *   })
 * }, 'Click me');
 *
 * // Renders: <button class="btn btn-lg">
 * setIsActive(true);
 * // Renders: <button class="btn btn-active btn-lg">
 * ```
 *
 * @example
 * ```ts
 * // Array syntax: mix strings and objects
 * h('div', {
 *   class: classList([
 *     'card',
 *     { 'card-hover': isHovered },
 *     { 'card-selected': isSelected }
 *   ])
 * });
 * ```
 */
export function classList(classes: ClassObject | (string | ClassObject)[]): () => string
{
    return (): string =>
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
 * Resolves a ClassObject into an array of active class names. Each entry's
 * condition is evaluated (calling it if it's a function, which reads the
 * signal); if truthy, the class name is added to the result array.
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
        const isActive = typeof condition === 'function' ? condition() : condition;

        if (isActive)
        {
            result.push(className);
        }
    }
}
