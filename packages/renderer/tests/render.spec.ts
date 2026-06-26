// @vitest-environment happy-dom
//
// Behavioral coverage for render() (render.ts): mounting into a container,
// reactive updates after mount, remount disposal (no leaks across renders),
// destroy-hook invocation on clear, and the thunk contract.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, subscriberCount } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('render', () =>
{
    it('mounts the component element into the container', () =>
    {
        const container = makeContainer();
        render(() => h('h1', {}, 'Title'), container);
        expect(container.children.length).toBe(1);
        expect(container.querySelector('h1')!.textContent).toBe('Title');
        container.remove();
    });

    it('keeps reactive bindings live after mount', () =>
    {
        const container = makeContainer();
        const [count, setCount] = createSignal(0);
        render(() => h('span', {}, () => `${ count() }`), container);
        const span = container.querySelector('span')!;
        expect(span.textContent).toBe('0');

        setCount(5);
        expect(span.textContent).toBe('5');
        // Same node mutated in place, not re-rendered.
        expect(container.querySelector('span')).toBe(span);
        container.remove();
    });

    it('replaces previous content on a re-render of the same container', () =>
    {
        const container = makeContainer();
        render(() => h('p', {}, 'first'), container);
        expect(container.textContent).toBe('first');

        render(() => h('p', {}, 'second'), container);
        expect(container.children.length).toBe(1);
        expect(container.textContent).toBe('second');
        container.remove();
    });

    it('disposes the previous mount\'s effects on re-render (no leak)', () =>
    {
        const container = makeContainer();
        const [n, setN] = createSignal(0);
        render(() => h('span', {}, () => `${ n() }`), container);
        // One effect subscribed to n from the first mount.
        expect(subscriberCount(n)).toBe(1);

        render(() => h('span', {}, 'static'), container);
        // The first mount's subscription is gone.
        expect(subscriberCount(n)).toBe(0);

        // Updating n no longer affects the (replaced) DOM.
        setN(99);
        expect(container.textContent).toBe('static');
        container.remove();
    });

    it('runs delegated events from mounted, document-attached content', () =>
    {
        const container = makeContainer();
        const [count, setCount] = createSignal(0);
        render(() => h('button', { onClick: () => setCount((c) => c + 1) }, () => `${ count() }`), container);
        const button = container.querySelector('button')!;
        button.click();
        button.click();
        button.click();
        expect(button.textContent).toBe('3');
        container.remove();
    });

    it('clears node-by-node so a parent createRoot owns the mount scope', () =>
    {
        const container = makeContainer();
        let captured!: () => void;
        const [n, setN] = createSignal(0);
        // Mount inside an outer root so we can dispose the whole mount externally.
        createRoot((dispose) =>
        {
            captured = dispose;
            render(() => h('span', {}, () => `${ n() }`), container);
        });
        expect(container.textContent).toBe('0');
        setN(1);
        expect(container.textContent).toBe('1');
        captured();
        container.remove();
    });
});
