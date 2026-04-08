import { describe, it, expect } from 'vitest';
import { createSignal, h, For } from '@azerothjs/core';

describe('For()', () =>
{
    it('should render a list of items', () =>
    {
        const [items] = createSignal(['Apple', 'Banana', 'Cherry']);

        const el = For(
            { each: items, key: (item) => item },
            (item) => h('p', {}, item)
        );

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('Apple');
        expect(el.children[1].textContent).toBe('Banana');
        expect(el.children[2].textContent).toBe('Cherry');
    });

    it('should render empty when list is empty', () =>
    {
        const [items] = createSignal<string[]>([]);

        const el = For(
            { each: items, key: (item) => item },
            (item) => h('p', {}, item)
        );

        expect(el.children.length).toBe(0);
    });

    it('should add new items', () =>
    {
        const [items, setItems] = createSignal(['A', 'B']);

        const el = For(
            { each: items, key: (item) => item },
            (item) => h('p', {}, item)
        );

        expect(el.children.length).toBe(2);

        setItems(['A', 'B', 'C']);
        expect(el.children.length).toBe(3);
        expect(el.children[2].textContent).toBe('C');
    });

    it('should remove items', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For(
            { each: items, key: (item) => item },
            (item) => h('p', {}, item)
        );

        expect(el.children.length).toBe(3);

        setItems(['A', 'C']);
        expect(el.children.length).toBe(2);
        expect(el.children[0].textContent).toBe('A');
        expect(el.children[1].textContent).toBe('C');
    });

    it('should reuse DOM elements for same keys', () =>
    {
        const [items, setItems] = createSignal(['A', 'B', 'C']);

        const el = For(
            { each: items, key: (item) => item },
            (item) => h('p', {}, item)
        );

        const firstChild = el.children[0];
        const thirdChild = el.children[2];

        setItems(['A', 'C']);

        expect(el.children[0]).toBe(firstChild);
        expect(el.children[1]).toBe(thirdChild);
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

        const el = For(
            { each: todos, key: (todo) => todo.id },
            (todo) => h('div', {}, todo.text)
        );

        expect(el.children.length).toBe(2);
        expect(el.children[0].textContent).toBe('Buy milk');

        setTodos(prev => [...prev, { id: 3, text: 'Cook dinner' }]);
        expect(el.children.length).toBe(3);
        expect(el.children[2].textContent).toBe('Cook dinner');
    });

    it('should pass index to render function', () =>
    {
        const [items] = createSignal(['A', 'B', 'C']);

        const el = For(
            { each: items, key: (item) => item },
            (item, index) => h('p', {}, `${ index }: ${ item }`)
        );

        expect(el.children[0].textContent).toBe('0: A');
        expect(el.children[1].textContent).toBe('1: B');
        expect(el.children[2].textContent).toBe('2: C');
    });

    it('should support index as key', () =>
    {
        const [items] = createSignal(['X', 'Y', 'Z']);

        const el = For(
            { each: items, key: (_item, i) => i },
            (item) => h('p', {}, item)
        );

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('X');
    });
});
