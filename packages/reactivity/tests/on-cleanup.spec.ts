// @vitest-environment node
//
// Full behavioral coverage for onCleanup (on-cleanup.ts): teardown that fires before
// each effect re-run and once on disposal, registration order, and multiple callbacks.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createRoot,
    onCleanup
} from '@azerothjs/reactivity';

describe('onCleanup', () =>
{
    it('runs before the next re-run of the same effect', () =>
    {
        const log: string[] = [];
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            createEffect(() =>
            {
                const value = n();
                log.push(`run-${ value }`);
                onCleanup(() => log.push(`cleanup-${ value }`));
            });
            setN(1);
            setN(2);
            expect(log).toEqual([
                'run-0',
                'cleanup-0',
                'run-1',
                'cleanup-1',
                'run-2'
            ]);
            dispose();
            expect(log[log.length - 1]).toBe('cleanup-2');
        });
    });

    it('runs every registered callback, in registration order', () =>
    {
        const log: string[] = [];
        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                onCleanup(() => log.push('first'));
                onCleanup(() => log.push('second'));
                onCleanup(() => log.push('third'));
            });
            dispose();
        });
        expect(log).toEqual(['first', 'second', 'third']);
    });

    it('fires exactly once per run even across many re-runs', () =>
    {
        let cleanupCalls = 0;
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            createEffect(() =>
            {
                n();
                onCleanup(() =>
                {
                    cleanupCalls++;
                });
            });
            setN(1);
            setN(2);
            setN(3);
            // 3 re-runs each cleaned the previous run = 3 cleanups so far.
            expect(cleanupCalls).toBe(3);
            dispose();
            // Final run's cleanup on dispose.
            expect(cleanupCalls).toBe(4);
        });
    });

    it('is a no-op (does not throw) when called outside any reactive scope', () =>
    {
        expect(() => onCleanup(() => undefined)).not.toThrow();
    });
});
