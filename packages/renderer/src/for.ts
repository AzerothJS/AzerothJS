// For renders a list of items, using a key function to track which items were
// added, removed, or reordered.
//
// Why: mapping a signal array straight into h() re-creates every element on
// every change, throwing away DOM (and its focus/scroll/IME state) needlessly.
//
// Without For: map the array inside a reactive child.
//
//     h('ul', {},
//         () => items().map((i) => h('li', {}, i.name))
//     ); // any change rebuilds every row, losing focus/scroll/IME state
//
// With For: key each item.
//
//     For(
//         { each: items, key: (i) => i.id },
//         (i) => h('li', {}, i.name)
//     ); // creates/removes only the changed rows, reusing the rest
//
// How keyed rendering works - given a key per item, a list change is a diff:
//
//   Old: [A, B, C, D]   (keys 1, 2, 3, 4)
//   New: [A, C, D, E]   (keys 1, 3, 4, 5)
//
//   B (key 2) -> removed (element removed)
//   E (key 5) -> created (new element)
//   A, C, D   -> kept    (same elements, no re-creation)

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
     *   - Same key: same item (reuse DOM element)
     *   - New key: new item (create DOM element)
     *   - Missing key: removed item (remove DOM element)
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
     * `<For each={...} key={...}>{(item, i) => ...}</For>`.
     */
    children: (item: T, index: () => number) => HTMLElement;
}

/**
 * Efficiently renders a reactive list of items with keyed tracking.
 *
 * Only creates/removes DOM elements for items that actually changed.
 * Existing items keep their DOM elements - no unnecessary re-creation.
 *
 * @typeParam T - The type of items in the list
 *
 * @param props - ForProps with `each` (items signal) and `key` (identity fn)
 * @param renderItem - Function that creates a DOM element for one item.
 *                     Receives the item and a reactive index getter.
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
 *     // `index` is a getter - wrap in a function to stay reactive
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
 * key leaves the list - without this, removed items leak forever.
 *
 * @internal
 */
interface KeyEntry
{
    el: HTMLElement;
    dispose: DisposeFn;

    /**
     * Pushes the item's current position into its reactive index
     * signal. Called when a reused item shifts to a new index on
     * reorder, so any `index()`-dependent binding updates without
     * the element being rebuilt.
     */
    setIndex: (index: number) => void;
}

/**
 * A row's reactive index, allocated lazily: most render functions never read
 * `index`, so the signal and its graph bookkeeping are only created on the
 * first call. Until then (and for rows that never ask) a reorder just
 * updates the plain number, which the signal picks up as its initial value
 * if a first read comes later.
 *
 * @internal
 */
function createRowIndex(initial: number): { get: () => number; set: (next: number) => void }
{
    let current = initial;
    let getter: (() => number) | null = null;
    let setter: ((next: number) => void) | null = null;

    return {
        get: (): number =>
        {
            if (getter === null)
            {
                [getter, setter] = createSignal(current);
            }
            return getter();
        },
        set: (next: number): void =>
        {
            current = next;
            if (setter !== null)
            {
                setter(next);
            }
        }
    };
}

export function For<T>(props: ForProps<T>): HTMLElement
{
    const renderItem = props.children;

    // Server-side rendering.
    // Map each item ONCE (index is static within a single render). Each row
    // is a single element, so the client hydrator adopts them in order - no
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

    // Hydration.
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
 * populated) and the reconcile passes are skipped - the DOM already matches.
 *
 * @internal
 */
function driveFor<T>(props: ForProps<T>, renderItem: ForProps<T>['children'], container: HTMLElement, hydrateFirstRun: boolean): void
{
    let firstRun = hydrateFirstRun;

    // Map of key -> tracked entry (DOM element + per-item dispose).
    let keyMap = new Map<string | number, KeyEntry>();

    // Entries displaced by a duplicate key. The duplicate's element stays in
    // the DOM until the next reconcile sweeps it out, so its root can only be
    // disposed then (or on unmount). Without this list a duplicated key's
    // first entry leaked its effects permanently.
    let orphans: KeyEntry[] = [];

    // Warn once per <For> - a duplicate usually repeats every reconcile and
    // per-occurrence logging would flood the console.
    let warnedDuplicateKey = false;

    createEffect(() =>
    {
        const items = props.each();

        // Only `each` drives the reconcile - everything below (key fns,
        // render fns, signal reads inside them) runs UNTRACKED. Suspending
        // tracking once here, instead of wrapping each row's render call,
        // saves a closure and a save/restore pair per created row.
        untrack(() => reconcile(items));
    });

    function reconcile(items: T[]): void
    {
        // Hydration first run: adopt existing rows in order.
        if (firstRun)
        {
            firstRun = false;
            const cursor = new HydrationCursor(container);
            const adoptedMap = new Map<string | number, KeyEntry>();

            for (let i = 0; i < items.length; i++)
            {
                const item = items[i];
                const key = props.key(item, i);
                const index = createRowIndex(i);

                let el!: HTMLElement;
                let dispose!: DisposeFn;
                createRoot((d) =>
                {
                    dispose = d;
                    const rowDescriptor = renderItem(item, index.get);
                    // The next element in the span IS this row; capture it
                    // before the descriptor's hydrate consumes it.
                    el = cursor.peekElement() as HTMLElement;
                    hydrateChild(rowDescriptor, cursor);
                });

                adoptedMap.set(key, { el, dispose, setIndex: index.set });
            }

            keyMap = adoptedMap;
            return;
        }
        // Dispose roots orphaned by duplicate keys in the PREVIOUS run.
        // Their elements are not in this run's newOrder, so the reconcile
        // passes below sweep them out of the DOM.
        for (const orphan of orphans)
        {
            orphan.dispose();
            destroyComponent(orphan.el);
        }
        orphans = [];

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
                // Reused element - but its position may have changed.
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

                // Each item owns a (lazily allocated) reactive index.
                // renderItem receives the getter, so a binding like
                // `() => `${ index() + 1 }.`` stays correct across
                // reorders without rebuilding the element.
                const index = createRowIndex(i);

                createRoot((d) =>
                {
                    dispose = d;
                    el = renderItem(item, index.get);
                });
                newOrder[i] = el;

                // Keys are documented as unique. If user code violates
                // that, the displaced entry would otherwise become
                // unreachable and leak its root forever - keep it for
                // disposal on the next run, and say so: a silent duplicate
                // renders confusingly (reused rows churn every update).
                const displaced = newMap.get(key);
                if (displaced)
                {
                    if (!warnedDuplicateKey)
                    {
                        warnedDuplicateKey = true;
                        console.warn(`<For> received a duplicate key "${ String(key) }" - keys must be unique. The displaced row is torn down on the next update.`);
                    }
                    orphans.push(displaced);
                }
                newMap.set(key, { el, dispose, setIndex: index.set });
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

        // Pass 3: reconcile children to match newOrder with the minimum
        // number of moves. Nodes on the longest increasing subsequence of
        // surviving positions stay put; everything else is inserted before
        // its right neighbor. A swap of two distant rows is 2 DOM moves,
        // not O(n) - and nothing here indexes the live childNodes NodeList,
        // which is O(n) per access in some DOM implementations.
        reconcileChildren(container, newOrder);

        keyMap = newMap;
    }

    // When the surrounding root unmounts, tear down every per-item
    // root we accumulated. We can't put this in the main effect's
    // cleanup - that fires on every re-run and would wipe entries
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

        for (const orphan of orphans)
        {
            orphan.dispose();
            destroyComponent(orphan.el);
        }
        orphans = [];
    });
}

/**
 * Makes `container`'s children equal `newOrder` with the minimum number of
 * insertBefore moves. Departed nodes are removed first; of the survivors,
 * those on the longest increasing subsequence of old positions keep their
 * relative order and never move, and every other node (moved or new) is
 * inserted before its already-placed right neighbor in one right-to-left
 * walk.
 *
 * The current children are snapshotted once via firstChild/nextSibling - no
 * live-NodeList indexing, which costs O(n) per access in some DOM
 * implementations and made a 2-row swap O(n^2).
 *
 * @internal
 */
function reconcileChildren(container: HTMLElement, newOrder: HTMLElement[]): void
{
    // Emptied list: drop everything from the back. Back-first removal is
    // O(1) per node in array-backed DOM implementations; front-first would
    // shift the whole child array every time.
    if (newOrder.length === 0)
    {
        while (container.lastChild !== null)
        {
            container.removeChild(container.lastChild);
        }
        return;
    }

    // First render into an empty container: nothing to diff, just append.
    // Skips the membership Set and the survivor/position arrays entirely on
    // the create path.
    if (container.firstChild === null)
    {
        for (const el of newOrder)
        {
            container.appendChild(el);
        }
        return;
    }

    const wanted = new Set<HTMLElement>(newOrder);

    // Snapshot survivors in DOM order and remove departed nodes. After this
    // loop the container holds exactly the surviving elements.
    const survivors: HTMLElement[] = [];
    let node: ChildNode | null = container.firstChild;
    while (node !== null)
    {
        const next: ChildNode | null = node.nextSibling;
        if (wanted.has(node as HTMLElement))
        {
            survivors.push(node as HTMLElement);
        }
        else
        {
            container.removeChild(node);
        }
        node = next;
    }

    // Trim the common prefix and suffix. The dominant real updates (append,
    // prepend, a localized splice) collapse to a tiny middle window, and the
    // LIS below then only pays for that window.
    let start = 0;
    while (start < survivors.length && start < newOrder.length && survivors[start] === newOrder[start])
    {
        start++;
    }

    let oldEnd = survivors.length;
    let newEnd = newOrder.length;
    while (oldEnd > start && newEnd > start && survivors[oldEnd - 1] === newOrder[newEnd - 1])
    {
        oldEnd--;
        newEnd--;
    }

    if (start === newEnd)
    {
        // Survivors are a subset of newOrder, so an empty new window forces
        // an empty old window: nothing to do.
        return;
    }

    // Everything in the window goes before the first node of the common
    // suffix (or at the end).
    const windowAnchor: ChildNode | null = newEnd < newOrder.length ? newOrder[newEnd] : null;

    // Pure insertion (append/prepend/splice-in): no old nodes in the window,
    // so place the new ones left to right. Plain per-node insertion - a
    // DocumentFragment measured SLOWER here (moving N nodes out of a
    // fragment costs O(n^2) in array-backed DOM implementations), and with
    // a detached or anchor-terminated insert there is no reflow to batch.
    if (start === oldEnd)
    {
        for (let i = start; i < newEnd; i++)
        {
            container.insertBefore(newOrder[i], windowAnchor);
        }
        return;
    }

    // General window: positions[i] = where the window's i-th new node sits
    // among the old window nodes, -1 for freshly created nodes.
    const oldPosition = new Map<HTMLElement, number>();
    for (let i = start; i < oldEnd; i++)
    {
        oldPosition.set(survivors[i], i);
    }

    const windowLength = newEnd - start;
    const positions = new Array<number>(windowLength);
    for (let i = 0; i < windowLength; i++)
    {
        const pos = oldPosition.get(newOrder[start + i]);
        positions[i] = pos === undefined ? -1 : pos;
    }

    const stable = longestIncreasingRun(positions);

    // Right-to-left: a node on the stable run is already correctly placed
    // relative to everything to its right; anything else moves in front of
    // the previously placed node.
    let anchor: ChildNode | null = windowAnchor;
    let stableIdx = stable.length - 1;
    for (let i = windowLength - 1; i >= 0; i--)
    {
        const el = newOrder[start + i];
        if (stableIdx >= 0 && stable[stableIdx] === i)
        {
            stableIdx--;
        }
        else
        {
            container.insertBefore(el, anchor);
        }
        anchor = el;
    }
}

/**
 * Indices (into `positions`) of one longest strictly-increasing run,
 * ignoring -1 entries. Standard patience-sorting LIS with parent links,
 * O(n log n).
 *
 * @internal
 */
function longestIncreasingRun(positions: number[]): number[]
{
    // tails[k] = index of the smallest tail of any increasing run of
    // length k+1; parent[i] = predecessor of i in the run it extends.
    const tails: number[] = [];
    const parent = new Array<number>(positions.length).fill(-1);

    for (let i = 0; i < positions.length; i++)
    {
        const pos = positions[i];
        if (pos === -1)
        {
            continue;
        }

        let lo = 0;
        let hi = tails.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            if (positions[tails[mid]] < pos)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }

        if (lo > 0)
        {
            parent[i] = tails[lo - 1];
        }
        tails[lo] = i;
    }

    const run = new Array<number>(tails.length);
    let i = tails.length > 0 ? tails[tails.length - 1] : -1;
    for (let k = tails.length - 1; k >= 0; k--)
    {
        run[k] = i;
        i = parent[i];
    }

    return run;
}
