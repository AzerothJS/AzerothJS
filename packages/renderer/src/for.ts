/**
 * MODULE: renderer/for
 *
 * <For> renders a keyed list, tracking which items were added, removed, or reordered so a
 * list change creates/removes only the changed rows and REUSES the rest - preserving each
 * surviving row's DOM and its focus/scroll/IME/uncontrolled-input state. Mapping a signal
 * array straight into h() instead re-creates every element on every change.
 *
 * KEYED-DIFF MODEL (one key per item):
 *   Old: [A, B, C, D]  keys 1,2,3,4
 *   New: [A, C, D, E]  keys 1,3,4,5
 *   -> B removed, E created, A/C/D kept (same elements, no re-creation).
 * Reordering is reconciled with the minimum insertBefore moves: survivors on the longest
 * increasing subsequence of old positions stay put; everything else is inserted before its
 * already-placed right neighbour (see reconcileChildren / longestIncreasingRun below). Each
 * row owns a lazily-allocated reactive index so its position updates live on reorder
 * without rebuilding the element. The reconcile internals below carry their own comments.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, createSignal, onRootDispose, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { destroyComponent, type CoTarget, type MountNode, createCoMarkers, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, resolveReactive } from './h.ts';

/**
 * Props for the For component.
 *
 * @typeParam T - The type of items in the list
 */
export interface ForProps<T>
{
    /**
     * The items to render: an array, or a getter (thunk/signal) for reactivity.
     * The compiler emits a getter-object prop; a manual caller may pass `() => arr`
     * or a signal. `resolveReactive` unwraps it on each read, so the effect tracks
     * whatever it touches.
     */
    each: T[] | (() => T[]);

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
     *
     * Each row MUST render exactly one element (not a fragment-rooted
     * control-flow region): the reconciler tracks and moves rows by
     * element identity, and a DocumentFragment empties itself on
     * insertion, which would break both.
     */
    children: (item: T, index: () => number) => HTMLElement;
}

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

/**
 * For
 *
 * PURPOSE:
 * Renders a reactive list keyed by props.key, creating/removing only the rows that changed
 * and reusing the DOM of survivors. The per-row render receives a reactive index getter.
 *
 * WHY IT EXISTS:
 * `items().map(i => row)` inside a reactive hole rebuilds EVERY row on any list change -
 * discarding DOM and its focus/scroll/IME/uncontrolled-input state and re-running every
 * row's effects. For diffs by key so unchanged rows are untouched and only real
 * insertions, removals, and moves reach the DOM.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; the keyed list-control component. `<For>` lowers to a
 * `component` binding at a `slot` co-range; its `{(item, i) => ...}` render-function child
 * becomes a render sub-plan. Mode-dispatched: keyed reconcile on the client, one-pass
 * serialization for SSR, row-by-row adoption on hydration.
 *
 * INPUT CONTRACT:
 * - props.each: T[] or a getter; read reactively and the sole reconcile trigger.
 * - props.key: (item, index) => string|number; MUST be unique within the list.
 * - props.children: (item, indexGetter) => HTMLElement; the per-row builder.
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle; on the client the rows sit between two comment
 *   markers with NO wrapper element, so For works directly inside <table>/<tbody>,
 *   <select>, and <ul>.
 *
 * WHY THIS DESIGN:
 * Only `each` is tracked; key/render and any signals they read run untracked, so a row's
 * own reactivity never retriggers the whole reconcile. Each row builds in its own
 * createRoot (disposed when its key leaves the list). Reorders are minimized via a longest
 * increasing subsequence so a swap is O(moves), not O(n); the reactive index is allocated
 * lazily because most rows never read it.
 *
 * WHEN TO USE:
 * For any list whose rows have identity and may be inserted/removed/reordered, where
 * preserving per-row DOM state and avoiding full rebuilds matters.
 *
 * WHEN NOT TO USE:
 * For a fixed list that never changes (a plain map is fine). If there is no stable key,
 * fix the data model first - an index-as-key defeats the diff on reorder.
 *
 * EDGE CASES:
 * - Duplicate keys: warned once; the displaced row is torn down on the next reconcile (it
 *   is kept until then so its root is not leaked).
 * - Empty list: all rows removed; the comment markers remain.
 * - SSR maps each item once (index is static within a render); hydration adopts the server
 *   rows in order and a leftover row trips the hydrate fallback.
 *
 * PERFORMANCE NOTES:
 * Reuse is O(1) per surviving key; moves are minimized via LIS; the diff trims common
 * prefix/suffix so append/prepend/local-splice collapse to a tiny window. Survivors are
 * snapshotted via nextSibling to avoid O(n)-per-access live-NodeList indexing.
 *
 * DEVELOPER WARNING:
 * Keys MUST be unique and stable; a non-stable key (e.g. the array index) forces rebuilds
 * on reorder and loses row state - exactly what For prevents. Keep `children` a function
 * and read `index()` for position-dependent content rather than capturing the initial i.
 *
 * @typeParam T - The item type.
 * @param props - {@link ForProps}: `each`, `key`, `children`.
 * @returns An HTMLElement-typed control-flow handle owning the rows.
 * @see {@link Show}
 * @see {@link Switch}
 * @example
 * For({
 *   each: items,
 *   key: (i) => i.id,
 *   children: (item, index) => h('li', {}, () => `${ index() + 1 }. ${ item.name }`)
 * });
 */
export function For<T>(props: ForProps<T>): MountNode
{
    const renderItem = props.children;

    // Server-side rendering.
    // Map each item ONCE (index is static within a single render), then bracket
    // the rows with comment anchors so they are direct children of the real
    // parent on hydration too (no wrapper element - works inside <tbody> etc.).
    if (isStringMode())
    {
        const items = untrack(() => resolveReactive(props.each)) as T[];
        let inner = '';

        // entries() (not index reads) keeps each element typed T even when T itself
        // includes undefined - a guard would silently skip such rows.
        for (const [index, item] of items.entries())
        {
            inner += serializeChild(renderItem(item, () => index));
        }

        return wrapContentsAnchored('for', inner) as unknown as MountNode;
    }

    // Hydration.
    // Adopt the server's comment markers (reused as the live start/end anchors)
    // and the rows between them, then reconcile within that marker range.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveFor(props, renderItem, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: NO wrapper element. Two comment markers bracket the
    // rows so each row is a DIRECT child of the real parent - which lets <For>
    // be used inside <table>/<tbody>, <select>, and <ul>, where an intervening
    // <span> would break layout and `parent > tr` selectors. The reconcile
    // derives its parent live from the end marker's parent, so it works both
    // before this fragment is mounted (parent is the fragment) and after
    // (parent is the real container). See @azerothjs/component's co-range.ts.
    const { fragment, target } = createCoMarkers('for');

    driveFor(props, renderItem, target, false);

    return fragment;
}

/**
 * Wires the keyed-list reconcile effect onto `target`. Shared by the DOM path
 * (a marker range) and hydration (the adopted server span). On a hydrating
 * first run, each row is adopted from the existing server DOM (its key entry
 * populated) and the reconcile passes are skipped - the DOM already matches.
 *
 * @internal
 */
function driveFor<T>(props: ForProps<T>, renderItem: ForProps<T>['children'], target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
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
        const items = resolveReactive(props.each) as T[];

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
            const cursor = hydrationCursor as HydrationCursorType;
            const adoptedMap = new Map<string | number, KeyEntry>();

            for (const [i, item] of items.entries())
            {
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

            // No server rows beyond the ones we adopted; a leftover means the
            // server and client lists diverged. hydrate() recovers.
            cursor.assertExhausted('<For> rows');

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
        const newOrder: HTMLElement[] = new Array<HTMLElement>(items.length);

        // Pass 1: build the new key map. Reuse existing entries
        // where possible; create new ones (in their own root) for
        // new keys.
        for (const [i, item] of items.entries())
        {
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
        reconcileChildren(target, newOrder);

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
 * Makes the rows in `target`'s range equal `newOrder` with the minimum number
 * of insertBefore moves. Departed nodes are removed first; of the survivors,
 * those on the longest increasing subsequence of old positions keep their
 * relative order and never move, and every other node (moved or new) is
 * inserted before its already-placed right neighbor in one right-to-left walk.
 *
 * The range is `(target.start, target.end)` exclusive: the rows sit between two
 * comment markers in an arbitrary parent, so the walk is bounded by `end` and
 * never escapes into following siblings. The parent is read live
 * (`target.parent()`) because the parent changes when the returned fragment is
 * mounted.
 *
 * The current rows are snapshotted once via nextSibling - no live-NodeList
 * indexing, which costs O(n) per access in some DOM implementations and made a
 * 2-row swap O(n^2).
 *
 * @internal
 */
function reconcileChildren(target: CoTarget, newOrder: HTMLElement[]): void
{
    const parent = target.parent();
    const { start, end } = target;

    // First row in the range: the node just after the start marker, or the end
    // marker itself when the range is empty.
    const first: ChildNode | null = start.nextSibling;

    // Emptied list: when the marker range spans the WHOLE parent (the common
    // shape - <For> as the sole content of a <tbody>/<ul>), one bulk
    // textContent clear replaces N removals; the markers are re-appended to
    // preserve their identity. Otherwise drop every row in the range from the
    // back - back-first removal is O(1) per node in array-backed DOM
    // implementations; front-first would shift the whole child array every time.
    if (newOrder.length === 0)
    {
        if (start.previousSibling === null && end.nextSibling === null)
        {
            parent.textContent = '';
            parent.appendChild(start);
            parent.appendChild(end);
            return;
        }
        let node: ChildNode | null = end.previousSibling;
        while (node !== null && node !== start)
        {
            const prev: ChildNode | null = node.previousSibling;
            parent.removeChild(node);
            node = prev;
        }
        return;
    }

    // First render into an empty range: nothing to diff, just insert in order
    // before the end anchor. Skips the membership Set and the survivor/position
    // arrays entirely.
    if (first === end)
    {
        for (const el of newOrder)
        {
            parent.insertBefore(el, end);
        }
        return;
    }

    const wanted = new Set<HTMLElement>(newOrder);

    // Snapshot survivors in DOM order, DEFERRING removals: a full replacement
    // (zero survivors) of a whole-parent range then collapses to one bulk
    // textContent clear instead of N removals. The walk is bounded by the end
    // anchor so it never escapes the range into following siblings (critical on
    // the marker path, where the parent holds more than just these rows).
    const survivors: HTMLElement[] = [];
    const departed: ChildNode[] = [];
    let node: ChildNode | null = first;
    while (node !== null && node !== end)
    {
        const next: ChildNode | null = node.nextSibling;
        if (wanted.has(node as HTMLElement))
        {
            survivors.push(node as HTMLElement);
        }
        else
        {
            departed.push(node);
        }
        node = next;
    }

    // Full replacement of a whole-parent range: bulk-clear, restore the
    // markers, and insert the new rows in order.
    if (survivors.length === 0 && start.previousSibling === null && end.nextSibling === null)
    {
        parent.textContent = '';
        parent.appendChild(start);
        parent.appendChild(end);
        for (const el of newOrder)
        {
            parent.insertBefore(el, end);
        }
        return;
    }

    for (const gone of departed)
    {
        parent.removeChild(gone);
    }

    // After this point the range holds exactly the survivors.

    // Trim the common prefix and suffix. The dominant real updates (append,
    // prepend, a localized splice) collapse to a tiny middle window, and the
    // LIS below then only pays for that window.
    let startIdx = 0;
    while (startIdx < survivors.length && startIdx < newOrder.length && survivors[startIdx] === newOrder[startIdx])
    {
        startIdx++;
    }

    let oldEnd = survivors.length;
    let newEnd = newOrder.length;
    while (oldEnd > startIdx && newEnd > startIdx && survivors[oldEnd - 1] === newOrder[newEnd - 1])
    {
        oldEnd--;
        newEnd--;
    }

    if (startIdx === newEnd)
    {
        // Survivors are a subset of newOrder, so an empty new window forces
        // an empty old window: nothing to do.
        return;
    }

    // Everything in the window goes before the first node of the common suffix,
    // or before the end anchor when the window runs to the end. (newOrder is dense,
    // so the ?? only fires when newEnd === newOrder.length.)
    const windowAnchor: ChildNode = newOrder[newEnd] ?? end;

    // Pure insertion (append/prepend/splice-in): no old nodes in the window,
    // so place the new ones left to right. Plain per-node insertion - a
    // DocumentFragment measured SLOWER here (moving N nodes out of a
    // fragment costs O(n^2) in array-backed DOM implementations), and with
    // a detached or anchor-terminated insert there is no reflow to batch.
    if (startIdx === oldEnd)
    {
        for (let i = startIdx; i < newEnd; i++)
        {
            const el = newOrder[i];
            if (el !== undefined)
            {
                parent.insertBefore(el, windowAnchor);
            }
        }
        return;
    }

    // Pure two-element EXCHANGE (the classic swap): same elements in the
    // window, crossed at exactly two positions. Two insertBefore calls and an
    // allocation-free O(window) scan - skipping the position map and the LIS
    // the general path would build over everything BETWEEN the swapped pair.
    if (oldEnd - startIdx === newEnd - startIdx)
    {
        let first = -1;
        let second = -1;
        let extra = false;
        for (let i = startIdx; i < newEnd; i++)
        {
            if (survivors[i] !== newOrder[i])
            {
                if (first === -1)
                {
                    first = i;
                }
                else if (second === -1)
                {
                    second = i;
                }
                else
                {
                    extra = true;
                    break;
                }
            }
        }
        const a = first === -1 ? undefined : survivors[first];
        const b = second === -1 ? undefined : survivors[second];
        if (!extra && a !== undefined && b !== undefined && a === newOrder[second] && b === newOrder[first])
        {
            // Put b in a's slot, then a where b was (ref captured before b
            // moves). Adjacent pair: the first insert already yields b,a.
            const ref: ChildNode | null = b.nextSibling;
            parent.insertBefore(b, a);
            if (a.nextSibling !== ref)
            {
                parent.insertBefore(a, ref);
            }
            return;
        }
    }

    // General window: positions[i] = where the window's i-th new node sits
    // among the old window nodes, -1 for freshly created nodes.
    const oldPosition = new Map<HTMLElement, number>();
    for (let i = startIdx; i < oldEnd; i++)
    {
        const survivor = survivors[i];
        if (survivor !== undefined)
        {
            oldPosition.set(survivor, i);
        }
    }

    const windowLength = newEnd - startIdx;
    const positions = new Array<number>(windowLength);
    for (let i = 0; i < windowLength; i++)
    {
        const el = newOrder[startIdx + i];
        const pos = el === undefined ? undefined : oldPosition.get(el);
        positions[i] = pos === undefined ? -1 : pos;
    }

    const stable = longestIncreasingRun(positions);

    // Right-to-left: a node on the stable run is already correctly placed
    // relative to everything to its right; anything else moves in front of
    // the previously placed node.
    let anchor: ChildNode = windowAnchor;
    let stableIdx = stable.length - 1;
    for (let i = windowLength - 1; i >= 0; i--)
    {
        const el = newOrder[startIdx + i];
        if (el === undefined)
        {
            continue; // newOrder is dense; satisfies the indexed-access check only
        }
        if (stableIdx >= 0 && stable[stableIdx] === i)
        {
            stableIdx--;
        }
        else
        {
            parent.insertBefore(el, anchor);
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
        if (pos === undefined || pos === -1)
        {
            continue;
        }

        let lo = 0;
        let hi = tails.length;
        while (lo < hi)
        {
            const mid = (lo + hi) >> 1;
            // mid < tails.length and tails holds valid positions indices, so both
            // lookups are total; the ?? arms are unreachable and exist for the
            // indexed-access check alone.
            const tailIndex = tails[mid] ?? -1;
            const tailPos = positions[tailIndex] ?? -1;
            if (tailPos < pos)
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
            parent[i] = tails[lo - 1] ?? -1;
        }
        tails[lo] = i;
    }

    const run = new Array<number>(tails.length);
    let i = tails[tails.length - 1] ?? -1;
    for (let k = tails.length - 1; k >= 0; k--)
    {
        run[k] = i;
        i = parent[i] ?? -1;
    }

    return run;
}
