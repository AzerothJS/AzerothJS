// ============================================================================
// QUANTUM FRAMEWORK — For (Keyed List Rendering)
// ============================================================================
//
// For efficiently renders a list of items, using a key function
// to track which items were added, removed, or reordered.
//
// WITHOUT For:
//   h('ul', {}, () => items().map(item => h('li', {}, item.name)))
//   // RE-CREATES every <li> on every change! Terrible perf.
//
// WITH For:
//   For(
//     { each: items, key: (item) => item.id },
//     (item) => h('li', {}, item.name)
//   )
//   // Only creates/removes items that actually changed.
//   // Existing items are REUSED. Great perf.
//
// HOW KEYED RENDERING WORKS:
//
//   Old list: [A, B, C, D]     (keys: 1, 2, 3, 4)
//   New list: [A, C, D, E]     (keys: 1, 3, 4, 5)
//
//   B (key 2) → REMOVED (DOM element removed)
//   E (key 5) → CREATED (new DOM element)
//   A, C, D   → KEPT (same DOM elements, no re-creation!)
//
// ============================================================================

import { createEffect } from '../reactivity/effect.ts';

/**
 * Props for the For component.
 *
 * @typeParam T - The type of items in the list
 */
export interface ForProps<T>
{
    /**
     * A reactive getter that returns the array of items to render.
     *
     * Must be a function (signal getter) so changes are tracked.
     */
    each: () => T[];

    /**
     * A function that returns a unique key for each item.
     *
     * Receives the item and its index. Keys are used to track
     * identity across updates:
     *   - Same key = same item (reuse DOM element)
     *   - New key = new item (create DOM element)
     *   - Missing key = removed item (remove DOM element)
     *
     * Keys must be unique within the list.
     */
    key: (item: T, index: number) => string | number;
}

/**
 * Efficiently renders a reactive list of items with keyed tracking.
 *
 * Only creates/removes DOM elements for items that actually changed.
 * Existing items keep their DOM elements — no unnecessary re-creation.
 *
 * @typeParam T - The type of items in the list
 *
 * @param props - ForProps with `each` (items signal) and `key` (identity fn)
 * @param renderItem - Function that creates a DOM element for one item.
 *                     Receives the item and its index.
 *
 * @returns An HTMLElement containing the rendered list
 *
 * @example
 * ```ts
 * // With item property as key
 * interface Todo { id: number; text: string }
 *
 * const [todos, setTodos] = createSignal<Todo[]>
 * ([
 *     { id: 1, text: 'Buy milk' },
 *     { id: 2, text: 'Walk dog' }
 * ]);
 *
 * For(
 *   { each: todos, key: (todo) => todo.id },
 *   (todo, index) => h('div', {},
 *     `${ index + 1 }. ${ todo.text }`
 *   )
 * );
 * ```
 *
 * @example
 * ```ts
 * // With index as key
 * const [items] = createSignal(['A', 'B', 'C']);
 *
 * For(
 *   { each: items, key: (_, i) => i },
 *   (item) => h('p', {}, item)
 * );
 * ```
 *
 * @example
 * ```ts
 * // Simple string list
 * const [names] = createSignal(['Alice', 'Bob']);
 *
 * For(
 *   { each: names, key: (name) => name },
 *   (name) => h('p', {}, name)
 * );
 * ```
 */
export function For<T>(props: ForProps<T>, renderItem: (item: T, index: number) => HTMLElement): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    // Map of key → DOM element for tracking existing items
    let keyToElement = new Map<string | number, HTMLElement>();

    createEffect(() =>
    {
        const items = props.each();
        const newKeyToElement = new Map<string | number, HTMLElement>();
        const newElements: HTMLElement[] = [];

        for (let i = 0; i < items.length; i++)
        {
            const item = items[i];
            const key = props.key(item, i);

            // Check if we already have a DOM element for this key
            const existing = keyToElement.get(key);

            if (existing)
            {
                // REUSE existing DOM element
                newElements.push(existing);
                newKeyToElement.set(key, existing);
            }
            else
            {
                // CREATE new DOM element
                const el = renderItem(item, i);
                newElements.push(el);
                newKeyToElement.set(key, el);
            }
        }

        // Clear the container properly (not innerHTML)
        while (container.firstChild)
        {
            container.removeChild(container.firstChild);
        }

        // Append in new order
        for (const el of newElements)
        {
            container.appendChild(el);
        }

        // Update the key map for next time
        keyToElement = newKeyToElement;
    });

    return container as unknown as HTMLElement;
}
