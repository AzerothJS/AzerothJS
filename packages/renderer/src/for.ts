// ============================================================================
// AZEROTHJS — For (Keyed List Rendering)
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

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, createSignal, onRootDispose, isStringMode, isHydrating, untrack, serializeChild, wrapContents, hydrationNode, HydrationCursor } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { hydrateChild } from './h.ts';

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

    /**
     * Per-item render function. Receives the item and a REACTIVE
     * index getter (so a row's position updates live on reorder
     * without rebuilding the element).
     *
     * Named `children` and passed as a prop so the manual API
     * matches the compiled `.azeroth` form:
     * `<For each={…} key={…}>{(item, i) => …}</For>`.
     */
    children: (item: T, index: () => number) => HTMLElement;
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
 *                     Receives the item and a REACTIVE index getter.
 *                     Because keyed items are reused across reorders,
 *                     `index` is a `() => number` accessor (not a plain
 *                     number) so index-dependent bindings stay correct
 *                     when items move. Read it inside a reactive child
 *                     (e.g. `() => index() + 1`) to track changes.
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
 *     // `index` is a getter — wrap in a function to stay reactive
 *     // across reorders.
 *     () => `${ index() + 1 }. ${ todo.text }`
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
 * For({
 *   each: names,
 *   key: (name) => name,
 *   children: (name) => h('p', {}, name)
 * });
 * ```
 */
/**
 * Per-key tracking: the rendered element plus the createRoot
 * dispose for any reactive primitives the renderItem function
 * created. Disposing the root tears down those effects when the
 * key leaves the list — without this, removed items leak forever.
 *
 * @internal
 */
interface KeyEntry
{
    el: HTMLElement;
    dispose: DisposeFn;

    /**
     * Pushes the item's CURRENT position into its reactive index
     * signal. Called when a reused item shifts to a new index on
     * reorder, so any `index()`-dependent binding updates without
     * the element being rebuilt.
     */
    setIndex: (index: number) => void;
}

export function For<T>(props: ForProps<T>): HTMLElement
{
    const renderItem = props.children;

    // ── Server-side rendering ─────────────────────────────────
    // Map each item ONCE (index is static within a single render). Each row
    // is a single element, so the client hydrator adopts them in order — no
    // per-row markers needed.
    if (isStringMode())
    {
        const items = untrack(() => props.each());
        let inner = '';

        for (let i = 0; i < items.length; i++)
        {
            const index = i;
            inner += serializeChild(renderItem(items[index], () => index));
        }

        return wrapContents('for', inner) as unknown as HTMLElement;
    }

    // ── Hydration ─────────────────────────────────────────────
    // Adopt the wrapper span and its existing rows on the first effect run;
    // subsequent list changes use the normal keyed reconcile.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            driveFor(props, renderItem, cursor.takeElement('span'), true);
        }) as unknown as HTMLElement;
    }

    const container = document.createElement('span');
    container.style.display = 'contents';

    driveFor(props, renderItem, container, false);

    return container as unknown as HTMLElement;
}

/**
 * Wires the keyed-list reconcile effect onto `container`. Shared by the DOM
 * path (a fresh span) and hydration (the adopted server span). On a hydrating
 * first run, each row is adopted from the existing server DOM (its key entry
 * populated) and the reconcile passes are skipped — the DOM already matches.
 *
 * @internal
 */
function driveFor<T>(props: ForProps<T>, renderItem: ForProps<T>['children'], container: HTMLElement, hydrateFirstRun: boolean): void
{
    let firstRun = hydrateFirstRun;

    // Map of key → tracked entry (DOM element + per-item dispose).
    let keyMap = new Map<string | number, KeyEntry>();

    createEffect(() =>
    {
        const items = props.each();

        // ── Hydration first run: adopt existing rows in order ────
        if (firstRun)
        {
            firstRun = false;
            const cursor = new HydrationCursor(container);
            const adoptedMap = new Map<string | number, KeyEntry>();

            for (let i = 0; i < items.length; i++)
            {
                const item = items[i];
                const key = props.key(item, i);
                const [index, setIndex] = createSignal(i);

                let el!: HTMLElement;
                let dispose!: DisposeFn;
                createRoot((d) =>
                {
                    dispose = d;
                    const rowDescriptor = renderItem(item, index);
                    // The next element in the span IS this row; capture it
                    // before the descriptor's hydrate consumes it.
                    el = cursor.peekElement() as HTMLElement;
                    hydrateChild(rowDescriptor, cursor);
                });

                adoptedMap.set(key, { el, dispose, setIndex });
            }

            keyMap = adoptedMap;
            return;
        }
        const newMap = new Map<string | number, KeyEntry>();
        const newOrder: HTMLElement[] = new Array(items.length);

        // Pass 1: build the new key map. Reuse existing entries
        // where possible; create new ones (in their own root) for
        // new keys.
        for (let i = 0; i < items.length; i++)
        {
            const item = items[i];
            const key = props.key(item, i);
            const existing = keyMap.get(key);

            if (existing)
            {
                // Reused element — but its position may have changed.
                // Push the new index into its reactive signal so
                // `index()`-dependent bindings update on reorder
                // (no-op when the index is unchanged, since the
                // signal gates on equality).
                existing.setIndex(i);
                newOrder[i] = existing.el;
                newMap.set(key, existing);
                keyMap.delete(key);
            }
            else
            {
                let el!: HTMLElement;
                let dispose!: DisposeFn;

                // Each item owns a reactive index signal. renderItem
                // receives the getter, so a binding like
                // `() => `${ index() + 1 }.`` stays correct across
                // reorders without rebuilding the element.
                const [index, setIndex] = createSignal(i);

                createRoot((d) =>
                {
                    dispose = d;
                    el = renderItem(item, index);
                });
                newOrder[i] = el;
                newMap.set(key, { el, dispose, setIndex });
            }
        }

        // Pass 2: dispose entries for keys that left the list and
        // run any component destroy hooks on their elements.
        for (const entry of keyMap.values())
        {
            entry.dispose();
            destroyComponent(entry.el);
            // Element is still in the DOM; pass 3 will remove it.
        }

        // Pass 3: reconcile children to match newOrder using
        // insertBefore moves. This avoids the full clear+append
        // cycle (which would destroy focus/scroll/IME state on
        // surviving elements) and is O(n) in the worst case.
        for (let i = 0; i < newOrder.length; i++)
        {
            const want = newOrder[i];
            const have = container.childNodes[i];
            if (have !== want)
            {
                container.insertBefore(want, have ?? null);
            }
        }

        // Pass 4: remove any trailing nodes (leftover from removed
        // items that weren't displaced by a move).
        while (container.childNodes.length > newOrder.length)
        {
            container.removeChild(container.lastChild!);
        }

        keyMap = newMap;
    });

    // When the surrounding root unmounts, tear down every per-item
    // root we accumulated. We can't put this in the main effect's
    // cleanup — that fires on every re-run and would wipe entries
    // we still want. onRootDispose fires exactly once, on scope
    // teardown, which is what we need.
    onRootDispose(() =>
    {
        for (const entry of keyMap.values())
        {
            entry.dispose();
            destroyComponent(entry.el);
        }
        keyMap.clear();
    });
}
