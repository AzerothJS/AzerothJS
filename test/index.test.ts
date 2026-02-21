import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, createMemo, batch, h, render } from '../src';

describe('Quantum Public API', () =>
{
    it('should export createSignal', () =>
    {
        expect(typeof createSignal).toBe('function');
    });

    it('should export createEffect', () =>
    {
        expect(typeof createEffect).toBe('function');
    });

    it('should export createMemo', () =>
    {
        expect(typeof createMemo).toBe('function');
    });

    it('should export batch', () =>
    {
        expect(typeof batch).toBe('function');
    });

    it('should work end-to-end through the public API', () =>
    {
        // Create signals
        const [price, setPrice] = createSignal(100);
        const [quantity, setQuantity] = createSignal(2);

        // Create memo
        const total = createMemo(() => price() * quantity());

        // Track effect runs
        const results: number[] = [];
        const dispose = createEffect(() =>
        {
            results.push(total());
        });

        expect(results).toEqual([200]);

        setPrice(50);
        expect(results[results.length - 1]).toBe(100);

        batch(() =>
        {
            setPrice(200);
            setQuantity(3);
        });
        expect(results[results.length - 1]).toBe(600);

        // Dispose effect
        dispose();
        setPrice(999);
        expect(results[results.length - 1]).toBe(600);
    });

    it('should render reactive UI through the public API', () =>
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
    });
});
