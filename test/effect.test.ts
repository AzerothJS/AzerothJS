import { describe, it, expect, vi } from 'vitest';

import { createSignal } from '../src/reactivity/signal.ts';
import { createEffect } from '../src/reactivity/effect.ts';

describe('createEffect', () =>
{
    it('should run immediately on creation', () =>
    {
        const fn = vi.fn();

        createEffect(fn);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should re-run when a signal it reads changes', () =>
    {
        const [count, setCount] = createSignal(0);
        const values: number[] = [];

        createEffect(() =>
        {
            values.push(count());
        });

        setCount(1);
        setCount(2);
        setCount(3);

        expect(values).toEqual([0, 1, 2, 3]);
    });

    it('should stop running after dispose', () =>
    {
        const [count, setCount] = createSignal(0);
        const values: number[] = [];

        const dispose = createEffect(() =>
        {
            values.push(count());
        });

        setCount(1);
        dispose();
        setCount(2);
        setCount(3);

        expect(values).toEqual([0, 1]);
    });

    it('should run cleanup before re-execution', () =>
    {
        const [count, setCount] = createSignal(0);
        const cleanupFn = vi.fn();

        createEffect(() =>
        {
            count();
            return cleanupFn;
        });

        expect(cleanupFn).not.toHaveBeenCalled();

        setCount(1);
        expect(cleanupFn).toHaveBeenCalledTimes(1);

        setCount(2);
        expect(cleanupFn).toHaveBeenCalledTimes(2);
    });

    it('should run cleanup on dispose', () =>
    {
        const [count, setCount] = createSignal(0);
        const cleanupFn = vi.fn();

        const dispose = createEffect(() =>
        {
            count();
            return cleanupFn;
        });

        dispose();
        expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('should support deferred effects', () =>
    {
        const [count, setCount] = createSignal(0);
        const fn = vi.fn();

        createEffect(() =>
        {
            fn(count());
        }, { defer: true });

        expect(fn).not.toHaveBeenCalled();
    });

    it('should track multiple signals', () =>
    {
        const [firstName, setFirstName] = createSignal('John');
        const [lastName, setLastName] = createSignal('Doe');
        const values: string[] = [];

        createEffect(() =>
        {
            values.push(`${firstName()} ${lastName()}`);
        });

        setFirstName('Jane');
        setLastName('Smith');

        expect(values).toEqual(['John Doe', 'Jane Doe', 'Jane Smith']);
    });
});
