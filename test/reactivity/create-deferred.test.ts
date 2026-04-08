import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSignal, createEffect, createDeferred } from '@quantum/core';

describe('createDeferred', () =>
{
    beforeEach(() =>
    {
        vi.useFakeTimers();
    });

    afterEach(() =>
    {
        vi.useRealTimers();
    });

    it('should return the initial value immediately', () =>
    {
        const [value] = createSignal('hello');
        const deferred = createDeferred(value, { timeout: 200 });

        expect(deferred()).toBe('hello');
    });

    it('should not update until timeout elapses', () =>
    {
        const [value, setValue] = createSignal('a');
        const deferred = createDeferred(value, { timeout: 200 });

        setValue('b');

        // Not yet — timeout hasn't fired
        expect(deferred()).toBe('a');

        vi.advanceTimersByTime(100);
        expect(deferred()).toBe('a');

        vi.advanceTimersByTime(100);
        expect(deferred()).toBe('b');
    });

    it('should debounce rapid updates', () =>
    {
        const [value, setValue] = createSignal(0);
        const deferred = createDeferred(value, { timeout: 300 });

        // Rapid updates — each resets the timer
        setValue(1);
        vi.advanceTimersByTime(100);
        setValue(2);
        vi.advanceTimersByTime(100);
        setValue(3);
        vi.advanceTimersByTime(100);

        // Only 100ms since last update, not 300ms
        expect(deferred()).toBe(0);

        // 300ms since last update (setValue(3))
        vi.advanceTimersByTime(200);
        expect(deferred()).toBe(3);
    });

    it('should trigger effects only after debounce completes', () =>
    {
        const [value, setValue] = createSignal('start');
        const deferred = createDeferred(value, { timeout: 200 });

        const log: string[] = [];
        createEffect(() =>
        {
            log.push(deferred());
        });

        expect(log).toEqual(['start']);

        setValue('typing...');
        expect(log).toEqual(['start']);

        vi.advanceTimersByTime(200);
        expect(log).toEqual(['start', 'typing...']);
    });

    it('should use default timeout of 150ms when not specified', () =>
    {
        const [value, setValue] = createSignal('x');
        const deferred = createDeferred(value);

        setValue('y');

        vi.advanceTimersByTime(149);
        expect(deferred()).toBe('x');

        vi.advanceTimersByTime(1);
        expect(deferred()).toBe('y');
    });

    it('should handle multiple sequential debounced updates', () =>
    {
        const [value, setValue] = createSignal('a');
        const deferred = createDeferred(value, { timeout: 100 });

        // First debounced update
        setValue('b');
        vi.advanceTimersByTime(100);
        expect(deferred()).toBe('b');

        // Second debounced update
        setValue('c');
        vi.advanceTimersByTime(100);
        expect(deferred()).toBe('c');
    });

    it('should work with number values', () =>
    {
        const [count, setCount] = createSignal(0);
        const deferred = createDeferred(count, { timeout: 50 });

        expect(deferred()).toBe(0);

        setCount(42);
        vi.advanceTimersByTime(50);
        expect(deferred()).toBe(42);
    });

    it('should skip intermediate values', () =>
    {
        const [value, setValue] = createSignal(1);
        const deferred = createDeferred(value, { timeout: 100 });

        const log: number[] = [];
        createEffect(() =>
        {
            log.push(deferred());
        });

        expect(log).toEqual([1]);

        // Rapid: 1→2→3→4→5
        setValue(2);
        setValue(3);
        setValue(4);
        setValue(5);

        vi.advanceTimersByTime(100);
        // Should only see initial (1) and final (5), not 2,3,4
        expect(log).toEqual([1, 5]);
    });
});
