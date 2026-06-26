/**
 * MODULE: renderer/class-binding
 *
 * classList() converts an object or array of class conditions into a reactive class-string
 * getter, replacing error-prone manual concatenation (where a forgotten space silently
 * merges two classes, and each branch must be wired by hand). Each condition may be a static
 * boolean or a signal getter, so individual classes are independently reactive.
 */

/**
 * A class binding value: a static boolean, or a getter for reactivity.
 */
type ClassValue = boolean | (() => boolean);

/**
 * An object mapping class names to {@link ClassValue} conditions: true always includes,
 * false never includes, a getter includes reactively.
 *
 * @example
 * { 'btn': true, 'btn-primary': isPrimary, 'btn-disabled': false }
 */
export type ClassObject = Record<string, ClassValue>;

/**
 * classList
 *
 * PURPOSE:
 * Turns a {@link ClassObject} (or an array of strings and ClassObjects) into a `() => string`
 * getter suitable as the `class` prop, recomputing the class string when its reactive
 * conditions change.
 *
 * WHY IT EXISTS:
 * Building a class string by hand is bug-prone: spacing, conditional branches, and reactive
 * recomputation all have to be managed manually. classList declares the mapping once and
 * produces a getter that h() treats as a reactive attribute, so each class toggles
 * independently and spacing is automatic.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; an authoring helper. It returns a getter that resolveReactive unwraps
 * inside h()'s attribute effect, so reading a signal condition tracks it.
 *
 * INPUT CONTRACT:
 * - classes: a ClassObject, or an array mixing plain class strings and ClassObjects.
 *   Object values are booleans or getters.
 *
 * OUTPUT CONTRACT:
 * - Returns a `() => string` joining the active class names with single spaces. Calling it
 *   evaluates each condition (subscribing to any getter it reads).
 *
 * WHY THIS DESIGN:
 * Returning a getter (not a string) is what makes it reactive in h(): the getter is called
 * inside the attribute effect, so only the touched signals drive updates. Array support lets
 * static and conditional classes mix without manual joining.
 *
 * WHEN TO USE:
 * For elements whose class set depends on state - active/selected/disabled toggles, variant
 * combinations.
 *
 * WHEN NOT TO USE:
 * For a single static class (pass the string directly). For inline styles, use
 * {@link styleMap}.
 *
 * EDGE CASES:
 * - Falsey conditions are omitted; duplicate class names are not de-duplicated (author input).
 * - Reading it outside an effect returns a one-shot string that will not update.
 *
 * PERFORMANCE NOTES:
 * O(number of entries) per evaluation; runs only when a condition signal changes (h() binds
 * it as one attribute effect).
 *
 * DEVELOPER WARNING:
 * Pass the RESULT of classList as the prop (`class: classList({...})`) - it must remain a
 * getter to stay reactive; do not call it yourself when binding.
 *
 * @param classes - A {@link ClassObject} or an array of strings and ClassObjects.
 * @returns A getter resolving to the space-joined active class string.
 * @see {@link styleMap}
 * @example
 * h('button', {
 *   class: classList({ 'btn': true, 'btn-active': isActive, 'btn-lg': isLarge })
 * }, 'Click me');
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
 * Resolves a {@link ClassObject} into active class names: evaluates each condition (calling
 * it if a function, which reads the signal) and pushes truthy ones onto `result`.
 *
 * @internal
 * @param obj - The class object to resolve.
 * @param result - The array to push active class names into.
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
