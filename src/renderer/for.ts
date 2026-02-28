// ============================================================================
// QUANTUM FRAMEWORK — For (Keyed List Rendering)
// ============================================================================
//
// For efficiently renders a list of items, using a key function
// to track which items were added, removed, or reordered.
//
// WITHOUT For:
//   h('ul', {}, () => {
//     return items().map(item => h('li', {}, item.name));
//   })
//   // This RE-CREATES every <li> on every change!
//   // Even if only one item was added. Terrible performance.
//
// WITH For:
//   For({
//     each: items,
//     key: (item) => item.id,
//   }, (item) => h('li', {}, item.name))
//   // Only creates/removes the items that actually changed.
//   // Existing items are REUSED. Great performance.
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
//   This is MUCH faster than recreating all 4 elements.
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
     * Keys are used to track identity across updates:
     *   - Same key = same item (reuse DOM element)
     *   - New key = new item (create DOM element)
     *   - Missing key = removed item (remove DOM element)
     *
     * Keys must be unique within the list. Strings and numbers work best.
     */
    key: (item: T) => string | number;
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
 * @param renderItem - A function that creates a DOM element for one item.
 *                     Receives the item and its index.
 *
 * @returns An HTMLElement containing the rendered list
 *
 * @example
 * ```ts
 * interface Todo
 * {
 *     id: number;
 *     text: string;
 * }
 *
 * const [todos, setTodos] = createSignal<Todo[]>
 * ([
 *     { id: 1, text: 'Buy milk' },
 *     { id: 2, text: 'Walk dog' },
 * ]);
 *
 * For(
 *   { each: todos, key: (todo) => todo.id },
 *   (todo, index) => h('div', { class: 'todo-item' },
 *     h('span', {}, `${index + 1}. ${todo.text}`),
 *     h('button', {
 *       onClick: () => removeTodo(todo.id),
 *     }, '✕'),
 *   ),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Simple string list
 * const [names, setNames] = createSignal(['Alice', 'Bob', 'Charlie']);
 *
 * For(
 *   { each: names, key: (name) => name },
 *   (name) => h('p', {}, name),
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
            const key = props.key(item);

            const existing = keyToElement.get(key);

            if (existing)
            {
                newElements.push(existing);
                newKeyToElement.set(key, existing);
            }
            else
            {
                const el = renderItem(item, i);
                newElements.push(el);
                newKeyToElement.set(key, el);
            }
        }

        container.innerHTML = '';
        for (const el of newElements)
        {
            container.appendChild(el);
        }

        keyToElement = newKeyToElement;
    });

    return container as unknown as HTMLElement;
}
