import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, untrack } from '../src';

describe('untrack()', () =>
{
    it('should return the value without subscribing', () =>
    {
        const [count] = createSignal(42);

        const result = untrack(() => count());

        expect(result).toBe(42);
    });

    it('should not subscribe the effect to untracked signals', () =>
    {
        const [tracked, setTracked] = createSignal(0);
        const [untracked, setUntracked] = createSignal('hello');
        const results: string[] = [];

        createEffect(() =>
        {
            const t = tracked();
            const u = untrack(() => untracked());
            results.push(`${t}-${u}`);
        });

        expect(results).toEqual(['0-hello']);

        setUntracked('world');
        expect(results).toEqual(['0-hello']);

        setTracked(1);
        expect(results).toEqual(['0-hello', '1-world']);
    });

    it('should work with nested untrack calls', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        const results: number[] = [];

        createEffect(() =>
        {
            const result = untrack(() =>
            {
                return a() + untrack(() => b());
            });

            results.push(result);
        });

        expect(results).toEqual([3]);

        setA(10);
        setB(20);

        expect(results).toEqual([3]);
    });

    it('should restore subscriber context after untrack', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        const [c, setC] = createSignal(3);
        const results: string[] = [];

        createEffect(() =>
        {
            const aVal = a();
            const bVal = untrack(() => b());
            const cVal = c();
            results.push(`${aVal}-${bVal}-${cVal}`);
        });

        expect(results).toEqual(['1-2-3']);

        setB(20);
        expect(results).toEqual(['1-2-3']);

        setA(10);
        expect(results).toEqual(['1-2-3', '10-20-3']);

        setC(30);
        expect(results).toEqual(['1-2-3', '10-20-3', '10-20-30']);
    });
});
