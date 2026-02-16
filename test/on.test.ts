import { describe, it, expect } from 'vitest';
import { createSignal, on } from '../src';

describe('on()', () =>
{
    it('should run immediately with current values', () =>
    {
        const [count] = createSignal(5);
        const results: number[] = [];

        on([count], ([val]) =>
        {
            results.push(val as number);
        });

        expect(results).toEqual([5]);
    });

    it('should re-run only when specified deps change', () =>
    {
        const [count, setCount] = createSignal(0);
        const [name, setName] = createSignal('Alice');
        const results: string[] = [];

        on([count], ([countVal]) =>
        {
            results.push(`count: ${countVal}, name: ${name()}`);
        });

        expect(results).toEqual(['count: 0, name: Alice']);

        setName('Bob');
        expect(results).toEqual(['count: 0, name: Alice']);

        setCount(1);
        expect(results).toEqual(['count: 0, name: Alice', 'count: 1, name: Bob',]);
    });

    it('should provide previous values', () =>
    {
        const [count, setCount] = createSignal(0);
        const changes: Array<{ prev: number; curr: number }> = [];

        on([count], ([curr], [prev]) =>
        {
            changes.push({ prev: prev as number, curr: curr as number });
        });

        setCount(5);
        setCount(10);

        expect(changes).toEqual([
            { prev: undefined, curr: 0 },
            { prev: 0, curr: 5 },
            { prev: 5, curr: 10 },
        ]);
    });

    it('should watch multiple dependencies', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        const results: number[] = [];

        on([a, b], ([aVal, bVal]) =>
        {
            results.push((aVal as number) + (bVal as number));
        });

        expect(results).toEqual([3]);

        setA(10);
        expect(results).toEqual([3, 12]);

        setB(20);
        expect(results).toEqual([3, 12, 30]);
    });

    it('should defer initial run when defer: true', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        on([count], ([val]) =>
        {
            results.push(val as number);
        }, { defer: true });

        expect(results).toEqual([]);

        setCount(5);
        expect(results).toEqual([5]);
    });

    it('should return a dispose function', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        const dispose = on([count], ([val]) =>
        {
            results.push(val as number);
        });

        setCount(1);
        expect(results).toEqual([0, 1]);

        dispose();

        setCount(2);
        expect(results).toEqual([0, 1]);
    });
});
