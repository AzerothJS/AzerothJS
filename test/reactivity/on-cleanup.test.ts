import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, onCleanup } from '@quantum/core';

describe('onCleanup', () =>
{
    it('should run cleanup before effect re-runs', () =>
    {
        const [count, setCount] = createSignal(0);
        const log: string[] = [];

        createEffect(() =>
        {
            const c = count();
            log.push(`run:${ c }`);
            onCleanup(() => log.push(`cleanup:${ c }`));
        });

        expect(log).toEqual(['run:0']);

        setCount(1);
        expect(log).toEqual(['run:0', 'cleanup:0', 'run:1']);

        setCount(2);
        expect(log).toEqual(['run:0', 'cleanup:0', 'run:1', 'cleanup:1', 'run:2']);
    });

    it('should run cleanup on dispose', () =>
    {
        const cleaned = vi.fn();

        const dispose = createEffect(() =>
        {
            onCleanup(cleaned);
        });

        expect(cleaned).not.toHaveBeenCalled();

        dispose();
        expect(cleaned).toHaveBeenCalledOnce();
    });

    it('should support multiple onCleanup calls in one effect', () =>
    {
        const [count, setCount] = createSignal(0);
        const log: string[] = [];

        createEffect(() =>
        {
            count();
            onCleanup(() => log.push('cleanup-A'));
            onCleanup(() => log.push('cleanup-B'));
            onCleanup(() => log.push('cleanup-C'));
        });

        expect(log).toEqual([]);

        setCount(1);
        expect(log).toEqual(['cleanup-A', 'cleanup-B', 'cleanup-C']);
    });

    it('should work alongside return cleanup', () =>
    {
        const [count, setCount] = createSignal(0);
        const log: string[] = [];

        createEffect(() =>
        {
            count();
            onCleanup(() => log.push('onCleanup'));
            return () => log.push('return-cleanup');
        });

        expect(log).toEqual([]);

        setCount(1);
        expect(log).toEqual(['onCleanup', 'return-cleanup']);
    });

    it('should support conditional onCleanup', () =>
    {
        const [count, setCount] = createSignal(0);
        const log: string[] = [];

        createEffect(() =>
        {
            const c = count();

            if (c % 2 === 0)
            {
                onCleanup(() => log.push(`even-cleanup:${ c }`));
            }
            else
            {
                onCleanup(() => log.push(`odd-cleanup:${ c }`));
            }
        });

        setCount(1);
        expect(log).toEqual(['even-cleanup:0']);

        setCount(2);
        expect(log).toEqual(['even-cleanup:0', 'odd-cleanup:1']);
    });

    it('should be a no-op when called outside an effect', () =>
    {
        // Should not throw
        expect(() => onCleanup(() =>
        {})).not.toThrow();
    });

    it('should run all cleanups on dispose with multiple onCleanup calls', () =>
    {
        const log: string[] = [];

        const dispose = createEffect(() =>
        {
            onCleanup(() => log.push('A'));
            onCleanup(() => log.push('B'));
            onCleanup(() => log.push('C'));
        });

        expect(log).toEqual([]);

        dispose();
        expect(log).toEqual(['A', 'B', 'C']);
    });

    it('should reset cleanups on each run', () =>
    {
        const [count, setCount] = createSignal(0);
        const log: string[] = [];

        createEffect(() =>
        {
            const c = count();
            onCleanup(() => log.push(`cleanup:${ c }`));
        });

        setCount(1);
        expect(log).toEqual(['cleanup:0']);

        // Only cleanup:1 should run, NOT cleanup:0 again
        setCount(2);
        expect(log).toEqual(['cleanup:0', 'cleanup:1']);
    });
});
