import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, createMemo, createRoot } from '@azerothjs/core';

describe('createRoot', () =>
{
    it('should dispose all effects when root is disposed', () =>
    {
        const [count, setCount] = createSignal(0);
        let runCount = 0;

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                count();
                runCount++;
            });

            createEffect(() =>
            {
                count();
                runCount++;
            });

            // Both effects ran once during creation
            expect(runCount).toBe(2);

            runCount = 0;
            setCount(1);
            // Both effects re-ran
            expect(runCount).toBe(2);

            // Dispose the root — both effects are killed
            dispose();
        });

        runCount = 0;
        setCount(2);
        // Neither effect should run
        expect(runCount).toBe(0);
    });

    it('should return the value from the callback', () =>
    {
        const result = createRoot(() =>
        {
            return 42;
        });

        expect(result).toBe(42);
    });

    it('should return DOM elements from the callback', () =>
    {
        const el = createRoot(() =>
        {
            return document.createElement('div');
        });

        expect(el).toBeInstanceOf(HTMLDivElement);
    });

    it('should support nested roots with independent disposal', () =>
    {
        const [count, setCount] = createSignal(0);
        let outerRuns = 0;
        let innerRuns = 0;
        let disposeInner: (() => void) | undefined;

        createRoot(() =>
        {
            createEffect(() =>
            {
                count();
                outerRuns++;
            });

            createRoot((dispose) =>
            {
                disposeInner = dispose;
                createEffect(() =>
                {
                    count();
                    innerRuns++;
                });
            });
        });

        // Both ran once on creation
        expect(outerRuns).toBe(1);
        expect(innerRuns).toBe(1);

        outerRuns = 0;
        innerRuns = 0;
        setCount(1);
        expect(outerRuns).toBe(1);
        expect(innerRuns).toBe(1);

        // Dispose only the inner root
        disposeInner!();

        outerRuns = 0;
        innerRuns = 0;
        setCount(2);
        // Outer still runs, inner is disposed
        expect(outerRuns).toBe(1);
        expect(innerRuns).toBe(0);
    });

    it('should dispose memos created inside root', () =>
    {
        const [count, setCount] = createSignal(0);
        const computeFn = vi.fn(() => count() * 2);
        let memoValue: number | undefined;

        createRoot((dispose) =>
        {
            const doubled = createMemo(computeFn);
            memoValue = doubled();
            expect(memoValue).toBe(0);

            setCount(5);
            memoValue = doubled();
            expect(memoValue).toBe(10);

            dispose();
        });

        // After dispose, the internal effect of createMemo is stopped
        computeFn.mockClear();
        setCount(100);
        // Memo's internal effect should not re-run
        expect(computeFn).not.toHaveBeenCalled();
    });

    it('should be safe to call dispose multiple times', () =>
    {
        const [count, setCount] = createSignal(0);
        let runCount = 0;

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                count();
                runCount++;
            });

            dispose();
            dispose();
            dispose();
        });

        runCount = 0;
        setCount(1);
        expect(runCount).toBe(0);
    });

    it('should work with zero effects', () =>
    {
        // Should not throw
        const result = createRoot((dispose) =>
        {
            dispose();
            return 'ok';
        });

        expect(result).toBe('ok');
    });

    it('should dispose effects in reverse order', () =>
    {
        const log: string[] = [];

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                log.push('effect-A-run');
                return () => log.push('effect-A-cleanup');
            });

            createEffect(() =>
            {
                log.push('effect-B-run');
                return () => log.push('effect-B-cleanup');
            });

            log.length = 0; // clear initial run logs
            dispose();
        });

        // B was created last, so it should be cleaned up first
        expect(log).toEqual(['effect-B-cleanup', 'effect-A-cleanup']);
    });
});
