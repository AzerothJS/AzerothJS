/**
 * Class conditions as a reactive class-string getter, in place of manual concatenation where
 * a forgotten space silently merges two class names. Each condition may be a static boolean
 * or a getter, so individual classes toggle independently.
 */

/** A static boolean, or a getter for a class that toggles reactively. */
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
 * Turns class conditions into a `() => string` getter for the `class` prop, recomputing when
 * a reactive condition changes.
 *
 * Pass the RESULT as the prop and never call it yourself when binding: it has to stay a
 * getter, because h() calls it inside the attribute effect and that call is what subscribes
 * to the signals each condition reads. Read outside an effect it returns a one-shot string
 * that never updates.
 *
 * Falsey conditions are omitted. Duplicate class names are not de-duplicated, since they are
 * author input.
 *
 * @param classes - A {@link ClassObject}, or an array mixing plain class strings with
 *                  ClassObjects.
 * @returns A getter resolving to the space-joined active classes.
 * @example
 * h('button', {
 *     class: classList({ 'btn': true, 'btn-active': isActive, 'btn-lg': isLarge })
 * }, 'Click me');
 *
 * @example
 * // Static and conditional classes mix without manual joining.
 * classList(['card', { 'card-hover': isHovered }]);
 *
 * @see {@link styleMap} for inline styles.
 */
export function classList(classes: ClassObject | (string | ClassObject)[]): () => string
{
    return (): string =>
    {
        const result: string[] = [];

        if (Array.isArray(classes))
        {
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
            resolveClassObject(classes, result);
        }

        return result.join(' ');
    };
}

/** Evaluates each condition, calling it when it is a getter, and pushes the active names. */
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
