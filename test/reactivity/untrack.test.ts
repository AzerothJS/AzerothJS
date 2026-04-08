import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, untrack } from '@quantum/core';

describe('untrack()', () =>
{
    it('should read value without subscribing', () =>
    {
        const [tracked, setTracked] = createSignal(0);
        const [untracked, setUntracked] = createSignal('hello');
        let runCount = 0;

        createEffect(() =>
        {
            tracked();
            untrack(() => untracked());
            runCount++;
        });

        runCount = 0;

        // Changing untracked signal should NOT re-run effect
        setUntracked('world');
        expect(runCount).toBe(0);

        // Changing tracked signal SHOULD re-run effect
        setTracked(1);
        expect(runCount).toBe(1);
    });

    it('should return the value from the function', () =>
    {
        const [count] = createSignal(42);
        const result = untrack(() => count());

        expect(result).toBe(42);
    });

    it('should restore subscriber context after untrack', () =>
    {
        const [a, setA] = createSignal(0);
        const [b] = createSignal(0);
        const [c, setC] = createSignal(0);
        let runCount = 0;

        createEffect(() =>
        {
            a();                       // tracked
            untrack(() => b());        // NOT tracked
            c();                       // tracked (restored)
            runCount++;
        });

        runCount = 0;

        setA(1);
        expect(runCount).toBe(1);

        setC(1);
        expect(runCount).toBe(2);
    });

    it('should work outside of effects', () =>
    {
        const [count] = createSignal(10);

        // Should not throw
        const result = untrack(() => count());
        expect(result).toBe(10);
    });
});
