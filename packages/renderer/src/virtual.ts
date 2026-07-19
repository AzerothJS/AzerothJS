/**
 * MODULE: renderer/virtual - windowed rendering without the re-slice trap
 *
 * Rendering ten thousand rows costs ten thousand rows; a viewport shows thirty. A
 * virtualizer renders the visible window (plus overscan) inside a spacer that preserves the
 * scrollbar, repositioning rows as the user scrolls.
 *
 * THE TRAP THIS EXISTS TO REMOVE: a hand-rolled virtualizer derives its window from the raw
 * scroll position - which changes EVERY FRAME - so the window memo invalidates and the list
 * re-slices and reconciles on every scrolled pixel, even when the visible rows are the same
 * thirty. The fix is an EQUALITY-GUARDED range memo (same start/end = same value, no
 * downstream work), which is exactly the subtle piece users ship without (the Guardian
 * report hand-built it, most apps will not). createVirtualizer owns that memo; <VirtualList>
 * packages the whole scroller.
 *
 * V1 SCOPE, DELIBERATE: fixed `itemSize` and an explicit viewport size - no dynamic
 * per-item measurement (a measurement cache is a future surface, and fixed-size covers
 * tables, feeds, and logs). Everything is plain CSS positioning: an outer scroller, a
 * spacer carrying the total height, absolutely-positioned rows.
 */

import { createMemo, createSignal, type Getter } from '@azerothjs/reactivity';
import { h } from './h.ts';
import { For } from './for.ts';
import type { MountNode } from '@azerothjs/component';

/** Options for {@link createVirtualizer}. */
export interface VirtualizerOptions
{
    /** Total item count - a getter so growth/shrink re-windows reactively. */
    count: () => number;

    /** Fixed size of one item along the scroll axis, in pixels. */
    itemSize: number;

    /** The viewport's size along the scroll axis, in pixels - a getter for resizable viewports. */
    viewportSize: () => number;

    /** Extra items rendered on EACH side of the visible window (default 5). */
    overscan?: number;
}

/** The half-open item window [start, end] currently worth rendering. */
export interface VirtualRange
{
    start: number;
    end: number;
}

/** What {@link createVirtualizer} returns - the headless windowing core. */
export interface Virtualizer
{
    /**
     * The window to render - an EQUALITY-GUARDED memo: scrolling within the
     * same window produces the SAME value, so nothing downstream re-runs.
     */
    range: Getter<VirtualRange>;

    /** Total scrollable size (count * itemSize) - the spacer's height. */
    totalSize: Getter<number>;

    /** The absolute offset (px) of one index - position rows with it. */
    offsetOf: (index: number) => number;

    /** Feed the current scroll position (the scroller's onScroll). */
    setScrollOffset: (offset: number) => void;
}

/**
 * The headless windowing core: feed it scroll positions, read an equality-guarded
 * range. Use it directly for bespoke layouts (horizontal lists, grids composed of
 * two virtualizers, custom scroll containers); reach for {@link VirtualList} when
 * a standard vertical list is all you need.
 */
export function createVirtualizer(options: VirtualizerOptions): Virtualizer
{
    const overscan = options.overscan ?? 5;
    const [scrollOffset, setScrollOffset] = createSignal(0);

    const range = createMemo<VirtualRange>(
        () =>
        {
            const count = options.count();
            const size = options.viewportSize();
            const offset = scrollOffset();
            // START-QUANTIZED window: the range depends only on the FIRST visible
            // row index plus a CONSTANT visible count (+1 covers the partial rows
            // at both edges). Scrolling within one row changes nothing - the
            // property that makes sub-row scrolling a reactive non-event. An
            // end-edge formula would re-quantize on single pixels.
            const first = Math.floor(offset / options.itemSize);
            const visible = Math.ceil(size / options.itemSize) + 1;
            return {
                start: Math.max(0, first - overscan),
                end: Math.min(Math.max(0, count - 1), first + visible - 1 + overscan)
            };
        },
        // The whole point: a scroll that lands in the same window is a non-event.
        { equals: (a, b) => a.start === b.start && a.end === b.end }
    );

    return {
        range,
        totalSize: createMemo(() => options.count() * options.itemSize),
        offsetOf: (index) => index * options.itemSize,
        setScrollOffset
    };
}

/** Props for the `<VirtualList>` component. */
export interface VirtualListProps<T>
{
    /** The full item array - a getter for reactivity; only the window renders. */
    each: () => T[];

    /** Unique, stable key per item (identity across updates, as in `<For>`). */
    key: (item: T, index: number) => string | number;

    /** Fixed row height in pixels. */
    itemHeight: number;

    /** Viewport height in pixels (explicit - measurement-free and SSR-safe). */
    height: number;

    /** Extra rows above and below the viewport (default 5). */
    overscan?: number;

    /** Class for the outer scroller element. */
    class?: string;

    /**
     * Per-item render function. Receives the item and its ABSOLUTE index getter.
     * The returned element is positioned by the list; give it `height: 100%` or
     * the row height itself.
     */
    children: (item: T, index: () => number) => HTMLElement;
}

/**
 * VirtualList
 *
 * PURPOSE:
 * A windowed vertical list: renders only the visible rows (plus overscan) of a large
 * array inside a real scrollbar, reconciling ONLY when the window actually moves.
 *
 * WHEN TO USE:
 * Any list long enough that rendering it all is wasteful - feeds, tables, logs,
 * search results in the thousands.
 *
 * WHEN NOT TO USE:
 * Short lists (<For> alone is simpler) or rows of genuinely variable height (v1 is
 * fixed-size; measure-and-cache is a future surface).
 *
 * @typeParam T - The item type.
 * @param props - {@link VirtualListProps}.
 * @returns The scroller element.
 * @see {@link createVirtualizer}
 * @see {@link For}
 */
export function VirtualList<T>(props: VirtualListProps<T>): MountNode
{
    const virtualizer = createVirtualizer({
        count: () => props.each().length,
        itemSize: props.itemHeight,
        viewportSize: () => props.height,
        overscan: props.overscan ?? 5
    });

    // Sliced ONLY when the window moves or the array identity changes - never
    // per scrolled pixel. Rows carry their absolute index for keying/positioning.
    const windowed = createMemo(() =>
    {
        const { start, end } = virtualizer.range();
        const items = props.each();
        const out: Array<{ item: T; index: number }> = [];
        for (let i = start; i <= end && i < items.length; i++)
        {
            out.push({ item: items[i] as T, index: i });
        }
        return out;
    });

    return h('div',
        {
            class: props.class,
            style: `overflow-y:auto;height:${ props.height }px;position:relative`,
            onscroll: (event: Event) => virtualizer.setScrollOffset((event.currentTarget as HTMLElement).scrollTop)
        },
        h('div', { style: () => `position:relative;height:${ virtualizer.totalSize() }px` },
            For({
                each: windowed,
                key: (row: { item: T; index: number }) => props.key(row.item, row.index),
                children: (row: { item: T; index: number }) =>
                    h('div',
                        {
                            style: `position:absolute;left:0;right:0;height:${ props.itemHeight }px;top:${ virtualizer.offsetOf(row.index) }px`
                        },
                        props.children(row.item, () => row.index))
            })));
}
