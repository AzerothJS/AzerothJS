// @vitest-environment happy-dom
//
// Cross-module integration: a createStore-backed store driving the real DOM through
// the renderer. Proves store reactivity flows all the way to the UI - mount, user
// interaction (a real click calling a store method), and surgical in-place text
// updates - plus that two independent components reading the SAME store stay in sync.
// No mocks: genuine signals, genuine happy-dom nodes, genuine event dispatch.
import { describe, it, expect } from 'vitest';
import { createSignal, createMemo } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';
import { createStore } from '@azerothjs/store';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('store + renderer integration', () =>
{
    it('a counter store updates the displayed text when a button calls its method', () =>
    {
        const useCounter = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, inc: () => setCount((n) => n + 1) };
        });

        const container = mount(() =>
        {
            const store = useCounter();
            return h('button', { onClick: () => store.inc() }, () => `Count: ${ store.count() }`);
        });

        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('Count: 0');

        button.click();
        expect(button.textContent).toBe('Count: 1');

        button.click();
        button.click();
        expect(button.textContent).toBe('Count: 3');

        // Surgical update: the same element instance is mutated in place.
        expect(container.querySelector('button')).toBe(button);
        container.remove();
    });

    it('two components reading the same store stay in sync through the DOM', () =>
    {
        const useCounter = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return { count, inc: () => setCount((n) => n + 1) };
        });

        const container = mount(() =>
        {
            const store = useCounter();
            // Two independent display components + a separate control, all sharing
            // the singleton store instance.
            return h('div', {},
                h('span', { class: 'a' }, () => `A:${ store.count() }`),
                h('span', { class: 'b' }, () => `B:${ store.count() }`),
                h('button', { onClick: () => store.inc() }, 'tick'));
        });

        const spanA = container.querySelector('.a')!;
        const spanB = container.querySelector('.b')!;
        const button = container.querySelector('button')!;

        expect(spanA.textContent).toBe('A:0');
        expect(spanB.textContent).toBe('B:0');

        button.click();
        // A single store mutation flows to BOTH readers - shared state, in sync.
        expect(spanA.textContent).toBe('A:1');
        expect(spanB.textContent).toBe('B:1');

        button.click();
        expect(spanA.textContent).toBe('A:2');
        expect(spanB.textContent).toBe('B:2');
        container.remove();
    });

    it('a store memo drives the DOM and only repaints when its value changes', () =>
    {
        const useStore = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            const parity = createMemo(() => (count() % 2 === 0 ? 'even' : 'odd'));
            return { parity, inc: () => setCount((n) => n + 1) };
        });

        let repaints = 0;
        const container = mount(() =>
        {
            const store = useStore();
            return h('button', { onClick: () => store.inc() }, () =>
            {
                repaints++;
                return store.parity();
            });
        });

        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('even');
        expect(repaints).toBe(1);

        button.click(); // 0 -> 1 : flips parity -> repaint
        expect(button.textContent).toBe('odd');
        expect(repaints).toBe(2);

        button.click(); // 1 -> 2 : flips back -> repaint
        button.click(); // 2 -> 3 : flips again
        expect(button.textContent).toBe('odd');
        expect(repaints).toBe(4);
        container.remove();
    });
});
