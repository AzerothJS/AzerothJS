// @vitest-environment happy-dom
//
// createVirtualizer: the equality-guarded range is THE contract - scrolling inside
// the same window must be a reactive non-event. VirtualList: only the window
// renders, rows sit at absolute offsets, and scrolling re-windows.
import { describe, it, expect } from 'vitest';
import { createEffect, createRoot, createSignal } from '@azerothjs/reactivity';
import { h, render, createVirtualizer, VirtualList } from '@azerothjs/renderer';

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('createVirtualizer', () =>
{
    it('windows the visible items plus overscan and reports total size', () =>
    {
        createRoot((dispose) =>
        {
            const virtualizer = createVirtualizer({
                count: () => 1000,
                itemSize: 20,
                viewportSize: () => 200,
                overscan: 2
            });
            expect(virtualizer.totalSize()).toBe(20_000);
            expect(virtualizer.range()).toEqual({ start: 0, end: 12 }); // 11-row window + 2 overscan below
            virtualizer.setScrollOffset(1000); // first visible row = 50
            expect(virtualizer.range()).toEqual({ start: 48, end: 62 });
            expect(virtualizer.offsetOf(48)).toBe(960);
            dispose();
        });
    });

    it('scrolling WITHIN the same window does not invalidate the range - the re-slice trap', () =>
    {
        createRoot((dispose) =>
        {
            const virtualizer = createVirtualizer({
                count: () => 1000,
                itemSize: 20,
                viewportSize: () => 200,
                overscan: 5
            });
            let runs = 0;
            createEffect(() =>
            {
                virtualizer.range();
                runs++;
            });
            expect(runs).toBe(1);

            virtualizer.setScrollOffset(3);  // same window
            virtualizer.setScrollOffset(7);  // same window
            virtualizer.setScrollOffset(19); // still the same 20px row
            expect(runs).toBe(1);

            virtualizer.setScrollOffset(200); // ten rows down: window moves
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('clamps the window at both ends and tracks a shrinking count', () =>
    {
        createRoot((dispose) =>
        {
            const [count, setCount] = createSignal(10);
            const virtualizer = createVirtualizer({
                count,
                itemSize: 50,
                viewportSize: () => 200,
                overscan: 5
            });
            expect(virtualizer.range()).toEqual({ start: 0, end: 9 }); // clamped to count-1
            setCount(3);
            expect(virtualizer.range()).toEqual({ start: 0, end: 2 });
            dispose();
        });
    });
});

describe('VirtualList', () =>
{
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, label: `row ${ i }` }));

    it('renders only the window, positioned at absolute offsets inside the full-height spacer', () =>
    {
        const container = makeContainer();
        render(() => VirtualList({
            each: () => items,
            key: (item) => item.id,
            itemHeight: 30,
            height: 300,
            overscan: 2,
            children: (item) => h('span', { class: 'row' }, item.label)
        }), container);

        const rows = container.querySelectorAll('.row');
        expect(rows.length).toBe(13); // 10 visible + 2 overscan + inclusive end
        expect(rows[0]?.textContent).toBe('row 0');

        // The spacer carries the full scrollable height.
        const spacer = container.firstElementChild?.firstElementChild as HTMLElement;
        expect(spacer.style.height).toBe('15000px');

        // Rows sit at their absolute offsets.
        const firstWrapper = rows[0]?.parentElement as HTMLElement;
        expect(firstWrapper.style.top).toBe('0px');
        container.remove();
    });

    it('re-windows on scroll', () =>
    {
        const container = makeContainer();
        render(() => VirtualList({
            each: () => items,
            key: (item) => item.id,
            itemHeight: 30,
            height: 300,
            overscan: 0,
            children: (item) => h('span', { class: 'row' }, item.label)
        }), container);

        const scroller = container.firstElementChild as HTMLElement;
        Object.defineProperty(scroller, 'scrollTop', { value: 3000, configurable: true });
        scroller.dispatchEvent(new Event('scroll'));

        const labels = [...container.querySelectorAll('.row')].map((el) => el.textContent);
        expect(labels[0]).toBe('row 100');
        container.remove();
    });

    it('a changed array identity re-renders the same window with reused keyed rows', () =>
    {
        const container = makeContainer();
        const [data, setData] = createSignal(items);
        render(() => VirtualList({
            each: data,
            key: (item) => item.id,
            itemHeight: 30,
            height: 300,
            overscan: 0,
            children: (item) => h('span', { class: 'row' }, item.label)
        }), container);

        const before = container.querySelector('.row');
        setData([...items]); // same content, new identity
        const after = container.querySelector('.row');
        expect(after).toBe(before); // keyed reuse across the re-slice
        container.remove();
    });
});
