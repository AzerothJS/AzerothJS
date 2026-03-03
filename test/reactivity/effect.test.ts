import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect } from '../../src';

describe('createEffect()', () =>
{
    it('should run immediately', () =>
    {
        const fn = vi.fn();
        createEffect(fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should re-run when a signal changes', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        createEffect(() =>
        {
            results.push(count());
        });

        expect(results).toEqual([0]);

        setCount(1);
        expect(results).toEqual([0, 1]);

        setCount(2);
        expect(results).toEqual([0, 1, 2]);
    });

    it('should stop when disposed', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        const dispose = createEffect(() =>
        {
            results.push(count());
        });

        setCount(1);
        expect(results).toEqual([0, 1]);

        dispose();

        setCount(2);
        setCount(3);
        expect(results).toEqual([0, 1]);
    });

    it('should run cleanup before re-run', () =>
    {
        const [count, setCount] = createSignal(0);
        const order: string[] = [];

        createEffect(() =>
        {
            const val = count();
            order.push(`run:${ val }`);
            return () =>
            {
                order.push(`cleanup:${ val }`);
            };
        });

        expect(order).toEqual(['run:0']);

        setCount(1);
        expect(order).toEqual(['run:0', 'cleanup:0', 'run:1']);
    });

    it('should run cleanup on dispose', () =>
    {
        const cleanupFn = vi.fn();

        const dispose = createEffect(() =>
        {
            return cleanupFn;
        });

        expect(cleanupFn).not.toHaveBeenCalled();

        dispose();
        expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('should track dynamic dependencies', () =>
    {
        const [showName, setShowName] = createSignal(true);
        const [name, setName] = createSignal('Alice');
        const [age, setAge] = createSignal(30);
        const results: string[] = [];

        createEffect(() =>
        {
            if (showName())
            {
                results.push(`name: ${ name() }`);
            }
            else
            {
                results.push(`age: ${ age() }`);
            }
        });

        expect(results).toEqual(['name: Alice']);

        setName('Bob');
        expect(results).toEqual(['name: Alice', 'name: Bob']);

        setShowName(false);
        expect(results).toEqual(['name: Alice', 'name: Bob', 'age: 30']);

        // Name no longer tracked
        setName('Charlie');
        expect(results.length).toBe(3);

        // Age now tracked
        setAge(25);
        expect(results).toEqual(['name: Alice', 'name: Bob', 'age: 30', 'age: 25']);
    });

    it('should clean up signal subscriptions on dispose (no memory leak)', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        const dispose = createEffect(() =>
        {
            results.push(count());
        });

        setCount(1);
        expect(results).toEqual([0, 1]);

        dispose();

        for (let i = 0; i < 1000; i++)
        {
            setCount(i);
        }

        expect(results).toEqual([0, 1]);
    });
});
