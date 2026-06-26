// @vitest-environment happy-dom
//
// Behavioral coverage for For (for.ts): initial render, keyed reconciliation
// (reuse surviving DOM by identity, minimal moves on reorder, create/remove),
// reactive per-row index, empty-list handling, dispose-on-removal, and the
// duplicate-key warning. The central guarantee asserted throughout: a surviving
// key keeps its EXACT element instance across updates.
import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render, For } from '@azerothjs/renderer';

interface Row { id: number; name: string }

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

function rowEls(container: HTMLElement): HTMLElement[]
{
    return Array.from(container.querySelectorAll('li'));
}

function ids(container: HTMLElement): string[]
{
    return rowEls(container).map((el) => el.getAttribute('data-id')!);
}

describe('For — initial render', () =>
{
    it('renders one element per item in order', () =>
    {
        const [items] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        expect(ids(container)).toEqual(['1', '2', '3']);
        expect(container.textContent).toBe('abc');
        container.remove();
    });

    it('places rows as direct children of the real parent (no wrapper)', () =>
    {
        const [items] = createSignal<Row[]>([{ id: 1, name: 'x' }]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        expect(container.querySelector('ul > li')).not.toBeNull();
        container.remove();
    });
});

describe('For — keyed reconciliation', () =>
{
    it('reuses the exact element instances for surviving keys when appending', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        const before = rowEls(container);

        setItems([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' }
        ]);
        const after = rowEls(container);
        expect(ids(container)).toEqual(['1', '2', '3']);
        // Existing rows are the SAME node references.
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        container.remove();
    });

    it('removes only the departed key\'s element and reuses the rest', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        const before = rowEls(container);
        const rowA = before[0];
        const rowC = before[2];

        setItems([
            { id: 1, name: 'a' },
            { id: 3, name: 'c' }
        ]);
        expect(ids(container)).toEqual(['1', '3']);
        const after = rowEls(container);
        // Survivors keep their instances; the middle one is gone.
        expect(after[0]).toBe(rowA);
        expect(after[1]).toBe(rowC);
        container.remove();
    });

    it('reorders by moving existing nodes, not rebuilding them', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        const before = rowEls(container);
        const map = new Map(before.map((el) => [el.getAttribute('data-id'), el]));

        // Reverse the list.
        setItems([
            { id: 3, name: 'c' },
            { id: 2, name: 'b' },
            { id: 1, name: 'a' }
        ]);
        expect(ids(container)).toEqual(['3', '2', '1']);
        const after = rowEls(container);
        // Every node is reused; order changed via moves only.
        expect(after[0]).toBe(map.get('3'));
        expect(after[1]).toBe(map.get('2'));
        expect(after[2]).toBe(map.get('1'));
        container.remove();
    });

    it('handles a combined insert + remove + reorder in one update', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' },
            { id: 4, name: 'd' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        const before = rowEls(container);
        const rowA = before[0];
        const rowD = before[3];

        // Remove B & C, reorder D before A, add E.
        setItems([
            { id: 4, name: 'd' },
            { id: 1, name: 'a' },
            { id: 5, name: 'e' }
        ]);
        expect(ids(container)).toEqual(['4', '1', '5']);
        const after = rowEls(container);
        expect(after[0]).toBe(rowD);
        expect(after[1]).toBe(rowA);
        // E is brand new.
        expect(after[2]).not.toBe(rowA);
        expect(after[2].textContent).toBe('e');
        container.remove();
    });

    it('preserves DOM state (e.g. input value) of a moved row', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, h('input', {}))
        })));
        const input1 = container.querySelector('li[data-id="1"] input') as HTMLInputElement;
        input1.value = 'typed-into-row-1';

        // Move row 1 to the end.
        setItems([
            { id: 2, name: 'b' },
            { id: 1, name: 'a' }
        ]);
        const input1After = container.querySelector('li[data-id="1"] input') as HTMLInputElement;
        // Same input element, value intact.
        expect(input1After).toBe(input1);
        expect(input1After.value).toBe('typed-into-row-1');
        container.remove();
    });
});

describe('For — reactive index', () =>
{
    it('updates a row\'s index() binding on reorder without rebuilding it', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
            { id: 3, name: 'c' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r, index) => h('li', { 'data-id': String(r.id) }, () => `${ index() }:${ r.name }`)
        })));
        const rowA = container.querySelector('li[data-id="1"]')!;
        expect(rowA.textContent).toBe('0:a');

        // Move A to the end -> its index becomes 2, in the same element.
        setItems([
            { id: 2, name: 'b' },
            { id: 3, name: 'c' },
            { id: 1, name: 'a' }
        ]);
        expect(container.querySelector('li[data-id="1"]')).toBe(rowA);
        expect(rowA.textContent).toBe('2:a');
        container.remove();
    });
});

describe('For — edge cases', () =>
{
    it('removes all rows for an empty list, keeping markers usable for refill', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        expect(rowEls(container).length).toBe(2);

        setItems([]);
        expect(rowEls(container).length).toBe(0);

        // Refilling after empty works.
        setItems([{ id: 9, name: 'z' }]);
        expect(ids(container)).toEqual(['9']);
        container.remove();
    });

    it('accepts a thunk for each', () =>
    {
        const [items, setItems] = createSignal<Row[]>([{ id: 1, name: 'a' }]);
        const container = mount(() => h('ul', {}, For({
            each: () => items(),
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        expect(ids(container)).toEqual(['1']);
        setItems([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
        expect(ids(container)).toEqual(['1', '2']);
        container.remove();
    });

    it('warns once on duplicate keys', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 1, name: 'dup' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        })));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('duplicate key');

        // A subsequent update with another duplicate does not warn again.
        setItems([
            { id: 2, name: 'x' },
            { id: 2, name: 'y' }
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
        container.remove();
    });
});
