import { describe, it, expect } from 'vitest';
import { createSignal, h, render } from '../../src';

describe('render()', () =>
{
    it('should mount component into container', () =>
    {
        const container = document.createElement('div');

        render(
            () => h('p', {}, 'Hello'),
            container
        );

        expect(container.children.length).toBe(1);
        expect(container.textContent).toBe('Hello');
    });

    it('should clear existing content', () =>
    {
        const container = document.createElement('div');
        container.innerHTML = '<span>Old Content</span>';

        render(
            () => h('p', {}, 'New Content'),
            container
        );

        expect(container.children.length).toBe(1);
        expect(container.textContent).toBe('New Content');
    });

    it('should render reactive content', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = document.createElement('div');

        render(
            () => h('span', {}, () => `Count: ${ count() }`),
            container
        );

        expect(container.textContent).toBe('Count: 0');

        setCount(10);
        expect(container.textContent).toBe('Count: 10');
    });

    it('should render nested components', () =>
    {
        const container = document.createElement('div');

        render(
            () => h('div', {},
                h('h1', {}, 'Title'),
                h('p', {}, 'Content')
            ),
            container
        );

        expect(container.querySelector('h1')!.textContent).toBe('Title');
        expect(container.querySelector('p')!.textContent).toBe('Content');
    });

    it('should handle multiple renders', () =>
    {
        const container = document.createElement('div');

        render(() => h('p', {}, 'First'), container);
        expect(container.textContent).toBe('First');

        render(() => h('p', {}, 'Second'), container);
        expect(container.textContent).toBe('Second');
        expect(container.children.length).toBe(1);
    });

    it('should render complex trees', () =>
    {
        const container = document.createElement('div');
        const [items] = createSignal(['A', 'B', 'C']);

        render(
            () => h('div', {},
                h('h1', {}, 'List'),
                h('ul', {},
                    items().map(item => h('li', {}, item))
                )
            ),
            container
        );

        const lis = container.querySelectorAll('li');
        expect(lis.length).toBe(3);
    });
});
