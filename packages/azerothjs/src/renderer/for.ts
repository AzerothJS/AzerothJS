/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Keyed list rendering. A list change creates and removes only the rows that changed and
 * REUSES the rest, so a surviving row keeps its DOM along with its focus, scroll, IME and
 * uncontrolled-input state. Mapping a signal array straight into h() re-creates every
 * element on every change instead.
 *
 * The diff is one key per item:
 *
 *     old: [A, B, C, D]  keys 1,2,3,4
 *     new: [A, C, D, E]  keys 1,3,4,5
 *     ->   B removed, E created, A/C/D kept as the same elements
 *
 * Reordering uses the minimum number of moves: survivors on the longest increasing
 * subsequence of old positions stay where they are, and everything else is inserted before
 * its already-placed right neighbour. Each row owns a lazily allocated reactive index, so a
 * reorder updates positions live without rebuilding elements.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createRoot, createSignal, onRootDispose, isStringMode, isHydrating, untrack } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import { describeArg } from '../reactivity/validate.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { destroyComponent, type CoTarget, type MountNode, createCoMarkers, adoptCoRange } from '../component/index.ts';
import { hydrateChild, resolveReactive } from './h.ts';

/**
 * Props for {@link For}.
 *
 * @typeParam T - The item type.
 */
export interface ForProps<T>
{
    /**
     * The items: an array, or a getter for reactivity. A nullish value renders nothing, so
     * `each={data()}` is safe before the data has loaded.
     */
    each: T[] | (() => T[]);

    /**
     * Returns a unique key per item, which is what identity tracking across updates is built
     * on: the same key reuses the element, a new key creates one, and a key that disappears
     * removes its element and disposes its scope.
     *
     * Keys MUST be unique within the list. Duplicates make the reconciler lose track of which
     * element belongs to which item.
     */
    key: (item: T, index: number) => string | number;

    /**
     * Builds one row, receiving REACTIVE getters rather than values. A row whose key survives
     * while its item is REPLACED - the immutable-update pattern every store produces -
     * updates in place, and a reorder updates `index()`; neither rebuilds the element.
     *
     * The getters are the load-bearing half of the keyed contract. With by-value parameters a
     * stable key froze the row on the values it was first built from, which was the single
     * most frequent defect found across applications built on this framework. In markup the
     * compiler emits the calls, so a row body still reads `item.name`.
     *
     * Each row MUST render exactly one element, never a fragment-rooted control-flow region:
     * the reconciler tracks and moves rows by element identity, and a DocumentFragment empties
     * itself on insertion, which breaks both.
     */
    children: (item: () => T, index: () => number) => HTMLElement;
}

/**
 * A nullish `each` - the not-yet-loaded `each={data()}` - renders nothing rather than
 * crashing on `.entries()`. A non-array, non-nullish value is a caller mistake, surfaced
 * clearly instead of as "Cannot read properties of null".
 */
function asItemArray<T>(value: unknown): T[]
{
    if (value === null || value === undefined)
    {
        return [];
    }
    if (!Array.isArray(value))
    {
        throw new TypeError(`<For each> expected an array, received ${ typeof value }. Pass an array or a getter that returns one.`);
    }
    return value as T[];
}

/**
 * Per-key tracking: the row's element plus the dispose for whatever reactive work its render
 * created. Disposing when the key leaves the list is what stops removed rows leaking.
 */
interface KeyEntry<T>
{
    el: HTMLElement;
    dispose: DisposeFn;

    /** Publishes a new position after a reorder, so `index()` bindings update in place. */
    setIndex: (index: number) => void;

    /** Publishes a replacement item under the same key, so `item()` bindings update in place. */
    setItem: (item: T) => void;
}

/**
 * A row's reactive slot, allocated lazily: many render functions never read the item or the
 * index, so the signal and its graph bookkeeping are created on the first read. Until then a
 * reconcile just updates the plain value, which the signal adopts as its initial value if a
 * read arrives later.
 */
function createRowCell<V>(initial: V): { get: () => V; set: (next: V) => void }
{
    let current = initial;
    let getter: (() => V) | null = null;
    let setter: ((next: V) => void) | null = null;

    return {
        get: (): V =>
        {
            if (getter === null)
            {
                [getter, setter] = createSignal(current);
            }
            return getter();
        },
        set: (next: V): void =>
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
 * Renders a keyed list, creating and removing only the rows that changed and reusing the DOM
 * of the survivors.
 *
 * `items().map(row)` inside a reactive hole rebuilds EVERY row on any list change,
 * discarding each one's focus, scroll, IME and uncontrolled-input state and re-running its
 * effects. For diffs by key instead, so only genuine insertions, removals and moves reach
 * the DOM.
 *
 * Keys must be unique AND stable. Using the array index as the key defeats the diff on
 * reorder and loses exactly the row state For exists to protect. A duplicate key warns once,
 * and the displaced row is torn down on the next reconcile - kept until then so its scope is
 * not leaked.
 *
 * Only `each` is tracked. The key and render functions, and any signals they read, run
 * untracked, so a row's own reactivity never re-triggers the whole reconcile. Each row
 * builds in its own root, disposed when its key leaves the list.
 *
 * The rows sit between two comment markers with NO wrapper element, so a For works directly
 * inside `<table>`, `<select>` and `<ul>`.
 *
 * Under SSR each item is mapped once, with a static index. While hydrating, the server's
 * rows are adopted in order, and a leftover row trips the hydration fallback.
 *
 * @typeParam T - The item type.
 * @param props - See {@link ForProps}.
 * @returns A control-flow handle owning the rows, typed as a node.
 * @throws {TypeError} If `key` is missing, or if `each` resolves to a non-array,
 *                     non-nullish value.
 * @example
 * For({
 *     each: items,
 *     key: (item) => item.id,
 *     children: (item, index) => h('li', {}, () => `${ index() + 1 }. ${ item().name }`)
 * });
 *
 * @see {@link Show} and {@link Switch} for conditional branches.
 */
export function For<T>(props: ForProps<T>): MountNode
{
    const renderItem = props.children;

    // Checked HERE, before the string-mode branch, so the server refuses exactly what the client
    // refuses. Without it, a keyless <For> serialized fine and then threw "props.key is not a
    // function" on mount - the page shipped and died, and the message named an internal prop
    // rather than the missing attribute. The compiler rejects this shape too
    // (`azeroth/for-missing-key`); this is the guard for hand-written h() callers.
    if (typeof props.key !== 'function')
    {
        throw new TypeError('<For> requires a `key` function: it tracks rows by key across '
            + `updates. Received ${ describeArg(props.key) }. Pass key={(item) => item.id} - any `
            + 'expression that is unique and stable per row.');
    }

    // Server-side rendering.
    // Map each item ONCE (index is static within a single render), then bracket
    // the rows with comment anchors so they are direct children of the real
    // parent on hydration too (no wrapper element - works inside <tbody> etc.).
    if (isStringMode())
    {
        const items = asItemArray<T>(untrack(() => resolveReactive(props.each)));
        let inner = '';

        // Keys are not NEEDED to serialize - a single pass has no reconciliation to do - but they
        // are checked anyway so the server reports the same defect the client does. Rendering is
        // identical either way, so nothing here diverges; what diverged was the DIAGNOSIS. A
        // duplicate key survives a server render silently and then, on the client's first
        // reconcile, tears the displaced row out - so a page developed and reviewed server-side
        // shipped with a defect whose only warning appeared somewhere the author never looked.
        const seenKeys = DEV ? new Set<string | number>() : null;
        let warnedDuplicateKey = false;

        // entries() (not index reads) keeps each element typed T even when T itself
        // includes undefined - a guard would silently skip such rows.
        for (const [index, item] of items.entries())
        {
            if (seenKeys !== null)
            {
                const key = props.key(item, index);
                if (seenKeys.has(key) && !warnedDuplicateKey)
                {
                    warnedDuplicateKey = true;
                    console.warn(`<For> received a duplicate key "${ String(key) }" - keys must be `
                        + 'unique. The server renders every row, but the client tears the displaced '
                        + 'row out on its first update.');
                }
                seenKeys.add(key);
            }
            inner += serializeChild(renderItem(() => item, () => index));
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
    // (parent is the real container). See azerothjs's co-range.ts.
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
    let keyMap = new Map<string | number, KeyEntry<T>>();

    // Entries displaced by a duplicate key. The duplicate's element stays in
    // the DOM until the next reconcile sweeps it out, so its root can only be
    // disposed then (or on unmount). Without this list a duplicated key's
    // first entry leaked its effects permanently.
    let orphans: Array<KeyEntry<T>> = [];

    // Warn once per <For> - a duplicate usually repeats every reconcile and
    // per-occurrence logging would flood the console.
    let warnedDuplicateKey = false;

    createEffect(() =>
    {
        const items = asItemArray<T>(resolveReactive(props.each));

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
            const adoptedMap = new Map<string | number, KeyEntry<T>>();

            for (const [i, item] of items.entries())
            {
                const key = props.key(item, i);
                const index = createRowCell(i);
                const cell = createRowCell(item);

                let el!: HTMLElement;
                let dispose!: DisposeFn;
                createRoot((d) =>
                {
                    dispose = d;
                    const rowDescriptor = renderItem(cell.get, index.get);
                    // The next element in the span IS this row; capture it
                    // before the descriptor's hydrate consumes it.
                    el = cursor.peekElement() as HTMLElement;
                    hydrateChild(rowDescriptor, cursor);
                });

                adoptedMap.set(key, { el, dispose, setIndex: index.set, setItem: cell.set });
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

        const newMap = new Map<string | number, KeyEntry<T>>();
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
                // Reused element - but its position and its ITEM may have
                // changed. Push both into their reactive cells so `index()`-
                // and `item()`-dependent bindings update without a rebuild
                // (each set is a no-op when the value is unchanged, since
                // the signal gates on equality).
                existing.setIndex(i);
                existing.setItem(item);
                newOrder[i] = existing.el;
                newMap.set(key, existing);
                keyMap.delete(key);
            }
            else
            {
                let el!: HTMLElement;
                let dispose!: DisposeFn;

                // Each row owns (lazily allocated) reactive cells for its
                // index and its item. renderItem receives the getters, so
                // bindings like `() => item().name` stay correct across
                // replacements and reorders without rebuilding the element.
                const index = createRowCell(i);
                const cell = createRowCell(item);

                createRoot((d) =>
                {
                    dispose = d;
                    el = renderItem(cell.get, index.get);
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
                    if (DEV && !warnedDuplicateKey)
                    {
                        warnedDuplicateKey = true;
                        console.warn(`<For> received a duplicate key "${ String(key) }" - keys must be unique. The displaced row is torn down on the next update.`);
                    }
                    orphans.push(displaced);
                }
                newMap.set(key, { el, dispose, setIndex: index.set, setItem: cell.set });
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
