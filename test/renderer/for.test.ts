import { describe, it, expect } from 'vitest';
import { createSignal, h, For, render } from '@azerothjs/core';

describe('For()', () =>
{
    it('should render a list of items', () =>
    {
        const [items] = createSignal(['Apple', 'Banana', 'Cherry']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('Apple');
        expect(el.children[1].textContent).toBe('Banana');
        expect(el.children[2].textContent).toBe('Cherry');
    });

    it('should render empty when list is empty', () =>
    {
        const [items] = createSignal<string[]>([]);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        expect(el.children.length).toBe(0);
    });

    it('should add new items', () =>
    {
        const [items, setItems] = createSignal(['A', 'B']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        expect(el.children.length).toBe(2);

        setItems(['A', 'B', 'C']);
        expect(el.children.length).toBe(3);
        expect(el.children[2].textContent).toBe('C');
    });

    it('should remove items', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        expect(el.children.length).toBe(3);

        setItems(['A', 'C']);
        expect(el.children.length).toBe(2);
        expect(el.children[0].textContent).toBe('A');
        expect(el.children[1].textContent).toBe('C');
    });

    it('should reuse DOM elements for same keys', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        const firstChild = el.children[0];
        const thirdChild = el.children[2];

        setItems(['A', 'C']);

        expect(el.children[0]).toBe(firstChild);
        expect(el.children[1]).toBe(thirdChild);
    });

    it('should reorder existing elements without re-creating them', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        const a = el.children[0];
        const b = el.children[1];
        const c = el.children[2];

        // Reorder to C, A, B.
        setItems(['C', 'A', 'B']);

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('C');
        expect(el.children[1].textContent).toBe('A');
        expect(el.children[2].textContent).toBe('B');

        // The SAME DOM nodes are reused - just moved, not rebuilt.
        expect(el.children[0]).toBe(c);
        expect(el.children[1]).toBe(a);
        expect(el.children[2]).toBe(b);
    });

    it('should handle a full reversal, reusing every element', () =>
    {
        const [items, setItems] = createSignal([1, 2, 3, 4]);

        const el = For({
            each: items,
            key: (n) => n,
            children: (n) => h('li', {}, String(n))
        });

        const original = Array.from(el.children);

        setItems([4, 3, 2, 1]);

        expect(Array.from(el.children).map((c) => c.textContent))
            .toEqual(['4', '3', '2', '1']);

        // Reversed, not recreated: first is the old last, etc.
        expect(el.children[0]).toBe(original[3]);
        expect(el.children[1]).toBe(original[2]);
        expect(el.children[2]).toBe(original[1]);
        expect(el.children[3]).toBe(original[0]);
    });

    it('should reorder and insert a new item in one update', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C', 'D']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item) => h('p', {}, item)
        });

        const a = el.children[0];

        // B removed, E added, the rest reordered: A, C, D, E.
        setItems(['A', 'C', 'D', 'E']);

        expect(Array.from(el.children).map((c) => c.textContent))
            .toEqual(['A', 'C', 'D', 'E']);
        // A survived in place.
        expect(el.children[0]).toBe(a);
    });

    it('should work with objects and id keys', () =>
    {
        interface Todo
        {
            id: number;
            text: string;
        }

        const [todos, setTodos] = createSignal<Todo[]>([
            { id: 1, text: 'Buy milk' },
            { id: 2, text: 'Walk dog' }
        ]);

        const el = For({
            each: todos,
            key: (todo) => todo.id,
            children: (todo) => h('div', {}, todo.text)
        });

        expect(el.children.length).toBe(2);
        expect(el.children[0].textContent).toBe('Buy milk');

        setTodos(prev => [...prev, { id: 3, text: 'Cook dinner' }]);
        expect(el.children.length).toBe(3);
        expect(el.children[2].textContent).toBe('Cook dinner');
    });

    it('should pass a reactive index getter to the render function', () =>
    {
        const [items] = createSignal(['A', 'B', 'C']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item, index) => h('p', {}, () => `${ index() }: ${ item }`)
        });

        expect(el.children[0].textContent).toBe('0: A');
        expect(el.children[1].textContent).toBe('1: B');
        expect(el.children[2].textContent).toBe('2: C');
    });

    it('should update the reactive index when items are reordered', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For({
            each: items,
            key: (item) => item,
            children: (item, index) => h('p', {}, () => `${ index() }: ${ item }`)
        });

        const a = el.children[0]; // "0: A"

        // Move A to the end: [B, C, A].
        setItems(['B', 'C', 'A']);

        expect(Array.from(el.children).map((c) => c.textContent))
            .toEqual(['0: B', '1: C', '2: A']);

        // A's element was reused (not rebuilt) but its index updated.
        expect(el.children[2]).toBe(a);
        expect(a.textContent).toBe('2: A');
    });

    it('should support index as key', () =>
    {
        const [items] = createSignal(['X', 'Y', 'Z']);

        const el = For({
            each: items,
            key: (_item, i) => i,
            children: (item) => h('p', {}, item)
        });

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('X');
    });
});

// Rows must be DIRECT children of their parent - no wrapper element - so <For>
// works inside <table>/<tbody>, <select>, and <ul>, and so `parent > tr`
// selectors (used by e.g. js-framework-benchmark) match. These mount through
// render() into a real container, which is where the marker-based range path
// (rather than the unmounted-fragment path the unit tests above exercise)
// takes effect.
describe('For() mounted in a parent with strict child types', () =>
{
    interface Row { id: number; label: string }

    const makeRows = (n: number): Row[] =>
        Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `row ${ i + 1 }` }));

    it('renders <tr> rows as direct children of <tbody>, with no wrapper element', () =>
    {
        const [rows] = createSignal(makeRows(3));
        const container = document.createElement('div');

        render(() => h('table', {},
            h('tbody', { id: 'tbody' },
                For({
                    each: rows,
                    key: (r) => r.id,
                    children: (r) => h('tr', {}, h('td', {}, r.label))
                })
            )
        ), container);

        const tbody = container.querySelector('#tbody')!;

        // No <span> (or any non-<tr>) wedged between <tbody> and its rows.
        expect(tbody.querySelector('span')).toBeNull();
        expect(Array.from(tbody.children).every((c) => c.tagName === 'TR')).toBe(true);

        // The selector the benchmark driver uses to find rows now matches.
        expect(container.querySelectorAll('tbody > tr').length).toBe(3);
        expect(Array.from(container.querySelectorAll('tbody > tr')).map((tr) => tr.textContent))
            .toEqual(['row 1', 'row 2', 'row 3']);
    });

    it('adds, removes, and clears rows in place inside <tbody>', () =>
    {
        const [rows, setRows] = createSignal(makeRows(3));
        const container = document.createElement('div');

        render(() => h('table', {},
            h('tbody', { id: 'tbody' },
                For({
                    each: rows,
                    key: (r) => r.id,
                    children: (r) => h('tr', {}, h('td', {}, r.label))
                })
            )
        ), container);

        const rowsOf = (): string[] =>
            Array.from(container.querySelectorAll('tbody > tr')).map((tr) => tr.textContent ?? '');

        // Append.
        setRows([...rows(), { id: 4, label: 'row 4' }]);
        expect(rowsOf()).toEqual(['row 1', 'row 2', 'row 3', 'row 4']);

        // Remove the middle row.
        setRows(rows().filter((r) => r.id !== 2));
        expect(rowsOf()).toEqual(['row 1', 'row 3', 'row 4']);

        // Clear, then refill - the markers must survive an empty range.
        setRows([]);
        expect(rowsOf()).toEqual([]);
        expect(container.querySelector('#tbody')!.querySelector('span')).toBeNull();

        setRows(makeRows(2));
        expect(rowsOf()).toEqual(['row 1', 'row 2']);
    });

    it('reorders/swaps rows inside <tbody> reusing the same <tr> elements', () =>
    {
        const [rows, setRows] = createSignal(makeRows(4));
        const container = document.createElement('div');

        render(() => h('table', {},
            h('tbody', { id: 'tbody' },
                For({
                    each: rows,
                    key: (r) => r.id,
                    children: (r) => h('tr', {}, h('td', {}, r.label))
                })
            )
        ), container);

        const trList = (): Element[] => Array.from(container.querySelectorAll('tbody > tr'));
        const before = trList();

        // Swap first and last (the benchmark's "swap rows" operation).
        const next = [...rows()];
        [next[0], next[3]] = [next[3], next[0]];
        setRows(next);

        const after = trList();
        expect(after.map((tr) => tr.textContent)).toEqual(['row 4', 'row 2', 'row 3', 'row 1']);

        // Same DOM nodes, moved not rebuilt.
        expect(after[0]).toBe(before[3]);
        expect(after[3]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
    });

    it('keeps sibling rows outside the <For> range intact', () =>
    {
        const [rows, setRows] = createSignal(makeRows(2));
        const container = document.createElement('div');

        // A static header row before the <For> and a static footer row after:
        // the reconcile must never reach past its markers and disturb them.
        render(() => h('table', {},
            h('tbody', { id: 'tbody' },
                h('tr', { id: 'header' }, h('td', {}, 'header')),
                For({
                    each: rows,
                    key: (r) => r.id,
                    children: (r) => h('tr', {}, h('td', {}, r.label))
                }),
                h('tr', { id: 'footer' }, h('td', {}, 'footer'))
            )
        ), container);

        const labels = (): string[] =>
            Array.from(container.querySelectorAll('tbody > tr')).map((tr) => tr.textContent ?? '');

        expect(labels()).toEqual(['header', 'row 1', 'row 2', 'footer']);

        setRows(makeRows(3));
        expect(labels()).toEqual(['header', 'row 1', 'row 2', 'row 3', 'footer']);

        setRows([]);
        expect(labels()).toEqual(['header', 'footer']);
        expect(container.querySelector('#header')).not.toBeNull();
        expect(container.querySelector('#footer')).not.toBeNull();
    });
});
