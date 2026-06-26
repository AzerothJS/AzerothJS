// @vitest-environment happy-dom
//
// Cross-module integration: the reactive core driving the real DOM renderer. Validates
// that signals/memos/effects/batch produce surgical, in-place DOM updates through h()
// and render() - no mocks, real happy-dom nodes.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createMemo,
    batch
} from '@azerothjs/reactivity';
import { h, render, classList } from '@azerothjs/renderer';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('reactivity + renderer', () =>
{
    it('a signal drives a text node and updates it in place on change', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = mount(() => h('button', {}, () => `Count: ${ count() }`));
        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('Count: 0');

        setCount(1);
        expect(button.textContent).toBe('Count: 1');
        // The same element instance is mutated - no component re-render.
        expect(container.querySelector('button')).toBe(button);
        container.remove();
    });

    it('an event handler mutates a signal which flows back into the DOM', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = mount(() =>
            h('button', { onClick: () => setCount((c) => c + 1) }, () => `${ count() }`));
        const button = container.querySelector('button')!;
        button.click();
        button.click();
        expect(button.textContent).toBe('2');
        container.remove();
    });

    it('classList produces a reactive class binding', () =>
    {
        const [active, setActive] = createSignal(false);
        const container = mount(() => h('div', { class: classList({ box: true, active }) }));
        const div = container.querySelector('div')!;
        expect(div.classList.contains('box')).toBe(true);
        expect(div.classList.contains('active')).toBe(false);

        setActive(true);
        expect(div.classList.contains('active')).toBe(true);
        container.remove();
    });

    it('a memo drives the DOM and only repaints when its value actually changes', () =>
    {
        const [n, setN] = createSignal(4);
        const parity = createMemo(() => (n() % 2 === 0 ? 'even' : 'odd'));
        let repaints = 0;
        const container = mount(() =>
            h('span', {}, () =>
            {
                repaints++;
                return parity();
            }));
        const span = container.querySelector('span')!;
        expect(span.textContent).toBe('even');
        expect(repaints).toBe(1);

        setN(6); // still even -> memo unchanged -> no repaint
        expect(span.textContent).toBe('even');
        expect(repaints).toBe(1);

        setN(7); // flips -> one repaint
        expect(span.textContent).toBe('odd');
        expect(repaints).toBe(2);
        container.remove();
    });

    it('batch collapses multiple signal writes into a single DOM update', () =>
    {
        const [first, setFirst] = createSignal('Ada');
        const [last, setLast] = createSignal('Lovelace');
        let repaints = 0;
        const container = mount(() =>
            h('p', {}, () =>
            {
                repaints++;
                return `${ first() } ${ last() }`;
            }));
        const p = container.querySelector('p')!;
        expect(p.textContent).toBe('Ada Lovelace');
        expect(repaints).toBe(1);

        batch(() =>
        {
            setFirst('Grace');
            setLast('Hopper');
        });
        expect(p.textContent).toBe('Grace Hopper');
        expect(repaints).toBe(2);
        container.remove();
    });
});
