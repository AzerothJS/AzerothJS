import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, batch } from '@quantum/core';

describe('batch()', () =>
{
    it('should defer effect execution', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        let runCount = 0;

        createEffect(() =>
        {
            a();
            b();
            runCount++;
        });

        runCount = 0;

        batch(() =>
        {
            setA(1);
            setB(2);
        });

        expect(runCount).toBe(1);
    });

    it('should have correct values after batch', () =>
    {
        const [a, setA] = createSignal('hello');
        const [b, setB] = createSignal('world');
        const results: string[] = [];

        createEffect(() =>
        {
            results.push(`${ a() } ${ b() }`);
        });

        batch(() =>
        {
            setA('foo');
            setB('bar');
        });

        expect(results).toEqual(['hello world', 'foo bar']);
    });

    it('should support nested batches', () =>
    {
        const [a, setA] = createSignal(0);
        const [b, setB] = createSignal(0);
        const [c, setC] = createSignal(0);
        let runCount = 0;

        createEffect(() =>
        {
            a();
            b();
            c();
            runCount++;
        });

        runCount = 0;

        batch(() =>
        {
            setA(1);
            batch(() =>
            {
                setB(2);
                setC(3);
            });
        });

        expect(runCount).toBe(1);
    });

    it('should deduplicate queued effects', () =>
    {
        const [count, setCount] = createSignal(0);
        let runCount = 0;

        createEffect(() =>
        {
            count();
            runCount++;
        });

        runCount = 0;

        batch(() =>
        {
            setCount(1);
            setCount(2);
            setCount(3);
        });

        expect(runCount).toBe(1);
        expect(count()).toBe(3);
    });

    it('should work without effects (no crash)', () =>
    {
        const [count, setCount] = createSignal(0);

        batch(() =>
        {
            setCount(10);
            setCount(20);
        });

        expect(count()).toBe(20);
    });

    it('should flush effects after batch completes', () =>
    {
        const [count, setCount] = createSignal(0);
        const results: number[] = [];

        createEffect(() =>
        {
            results.push(count());
        });

        batch(() =>
        {
            setCount(1);
            // During batch, effect hasn't run yet
            expect(results).toEqual([0]);
        });

        // After batch, effect has run
        expect(results).toEqual([0, 1]);
    });
});
