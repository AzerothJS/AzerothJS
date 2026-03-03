import { describe, it, expect } from 'vitest';
import { createSignal, on } from '../../src';

describe('on()', () =>
{
    it('should run immediately by default', () =>
    {
        const [count] = createSignal(5);
        const results: unknown[] = [];

        on([count], ([val]) =>
        {
            results.push(val);
        });

        expect(results).toEqual([5]);
    });

    it('should skip initial run with defer: true', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: unknown[] = [];

        on([count], ([val]) =>
        {
            results.push(val);
        }, { defer: true });

        expect(results).toEqual([]);

        setCount(1);
        expect(results).toEqual([1]);
    });

    it('should only track specified dependencies', () =>
    {
        const [count, setCount] = createSignal(0);
        const [name, setName] = createSignal('Alice');
        const results: unknown[] = [];

        on([count], ([val]) =>
        {
            // name() is read but NOT tracked
            name();
            results.push(val);
        });

        setName('Bob');
        expect(results).toEqual([0]); // Only initial run

        setCount(1);
        expect(results).toEqual([0, 1]); // Re-ran for count
    });

    it('should provide previous values', () =>
    {
        const [count, setCount] = createSignal(0);
        const changes: Array<{ prev: unknown; curr: unknown }> = [];

        on([count], ([curr], [prev]) =>
        {
            changes.push({ prev, curr });
        });

        setCount(5);
        setCount(10);

        expect(changes).toEqual([
            { prev: undefined, curr: 0 },
            { prev: 0, curr: 5 },
            { prev: 5, curr: 10 }
        ]);
    });

    it('should track multiple dependencies', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        const results: unknown[][] = [];

        on([a, b], ([aVal, bVal]) =>
        {
            results.push([aVal, bVal]);
        });

        expect(results).toEqual([[1, 2]]);

        setA(10);
        expect(results).toEqual([[1, 2], [10, 2]]);

        setB(20);
        expect(results).toEqual([[1, 2], [10, 2], [10, 20]]);
    });

    it('should dispose when called', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: unknown[] = [];

        const dispose = on([count], ([val]) =>
        {
            results.push(val);
        });

        setCount(1);
        expect(results).toEqual([0, 1]);

        dispose();

        setCount(2);
        setCount(3);
        expect(results).toEqual([0, 1]);
    });
});
