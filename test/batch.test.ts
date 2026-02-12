import { describe, it, expect, vi } from 'vitest';

import { createSignal } from '../src/reactivity/signal.ts';
import { createEffect } from '../src/reactivity/effect.ts';
import { batch } from '../src/reactivity/batch.ts';

describe('batch', () =>
{
    it('should batch multiple updates into one effect run', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        let result = 0;
        const fn = vi.fn(() =>
        {
            result = a() + b();
        });

        createEffect(fn);
        expect(fn).toHaveBeenCalledTimes(1);

        batch(() =>
        {
            setA(10);
            setB(20);
        });

        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should see the final values after batch', () =>
    {
        const [firstName, setFirstName] = createSignal('John');
        const [lastName, setLastName] = createSignal('Doe');
        const values: string[] = [];

        createEffect(() =>
        {
            values.push(`${firstName()} ${lastName()}`);
        });

        expect(values).toEqual(['John Doe']);

        batch(() =>
        {
            setFirstName('Jane');
            setLastName('Smith');
        });

        expect(values).toEqual(['John Doe', 'Jane Smith']);
    });

    it('should handle nested batches', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [c, setC] = createSignal(0);
        let result = 0;
        const fn = vi.fn(() =>
        {
            result = a() + b() + c();
        });

        createEffect(fn);
        expect(fn).toHaveBeenCalledTimes(1);

        batch(() =>
        {
            setA(1);
            batch(() =>
            {
                setB(2);
            });
            setC(3);
        });

        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should run effects immediately outside of batch', () =>
    {
        const [count, setCount] = createSignal(0);
        const values: number[] = [];

        createEffect(() =>
        {
            values.push(count());
        });

        setCount(1);
        setCount(2);
        setCount(3);

        expect(values).toEqual([0, 1, 2, 3]);
    });

    it('should deduplicate effects in batch', () =>
    {
        const [count, setCount] = createSignal(0);
        let result = 0;
        const fn = vi.fn(() =>
        {
            result = count();
        });

        createEffect(fn);
        expect(fn).toHaveBeenCalledTimes(1);

        batch(() =>
        {
            setCount(1);
            setCount(2);
            setCount(3);
        });

        expect(fn).toHaveBeenCalledTimes(2);
        expect(result).toBe(3);
    });

    it('should work with memos inside batch', async () =>
    {
        const { createMemo } = await import('../src/reactivity/memo.ts');

        const [price, setPrice] = createSignal(100);
        const [quantity, setQuantity] = createSignal(1);
        const total = createMemo(() => price() * quantity());
        const values: number[] = [];

        createEffect(() => {
            values.push(total());
        });

        expect(values).toEqual([100]);

        batch(() => {
            setPrice(200);
            setQuantity(3);
        });

        expect(values[values.length - 1]).toBe(600);
    });
});
