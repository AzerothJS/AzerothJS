import { describe, it, expect } from 'vitest';
import { createSignal, h, For } from '@azerothjs/core';

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

        // The SAME DOM nodes are reused — just moved, not rebuilt.
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
