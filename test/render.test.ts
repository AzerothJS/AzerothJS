import { describe, it, expect } from 'vitest';
import { createSignal, h, render } from '../src';

describe('render()', () =>
{
    it('should mount into a container', () =>
    {
        const container = document.createElement('div');

        render(
            () => h('p', {}, 'Hello Quantum'),
            container
        );

        expect(container.innerHTML).toBe('<p>Hello Quantum</p>');
    });

    it('should clear existing content in container', () =>
    {
        const container = document.createElement('div');
        container.innerHTML = '<p>Loading...</p>';

        render(
            () => h('p', {}, 'App loaded'),
            container
        );

        expect(container.innerHTML).toBe('<p>App loaded</p>');
    });

    it('should render reactive text that updates on signal change', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = document.createElement('div');

        render(
            () => h('p', {}, () => `Count: ${ count() }`),
            container
        );

        expect(container.textContent).toBe('Count: 0');

        setCount(5);
        expect(container.textContent).toBe('Count: 5');

        setCount(100);
        expect(container.textContent).toBe('Count: 100');
    });

    it('should render reactive attributes that update on signal change', () =>
    {
        const [isActive, setIsActive] = createSignal(false);
        const container = document.createElement('div');

        render(
            () => h('div', { class: () => isActive() ? 'active' : 'inactive' }),
            container
        );

        expect(container.children[0].getAttribute('class')).toBe('inactive');

        setIsActive(true);
        expect(container.children[0].getAttribute('class')).toBe('active');
    });

    it('should handle a full interactive app', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = document.createElement('div');

        render(
            () => h('div', {},
                h('p', {}, () => `Count: ${ count() }`),
                h('button', { onClick: () => setCount(prev => prev + 1) }, '+1')
            ),
            container
        );

        expect(container.querySelector('p')?.textContent).toBe('Count: 0');

        container.querySelector('button')?.click();
        expect(container.querySelector('p')?.textContent).toBe('Count: 1');

        container.querySelector('button')?.click();
        expect(container.querySelector('p')?.textContent).toBe('Count: 2');
    });

    it('should render deeply nested structures', () =>
    {
        const container = document.createElement('div');

        render(
            () => h('div', { class: 'app' },
                h('header', {},
                    h('h1', {}, 'Quantum App')
                ),
                h('main', {},
                    h('p', {}, 'Hello World')
                ),
                h('footer', {},
                    h('span', {}, '© 2026')
                )
            ),
            container
        );

        expect(container.querySelector('h1')?.textContent).toBe('Quantum App');
        expect(container.querySelector('p')?.textContent).toBe('Hello World');
        expect(container.querySelector('span')?.textContent).toBe('© 2026');
    });
});
