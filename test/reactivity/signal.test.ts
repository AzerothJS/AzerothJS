import { describe, it, expect } from 'vitest';
import { createSignal } from '../../src';

describe('createSignal()', () =>
{
    it('should return the initial value', () =>
    {
        const [count] = createSignal(0);
        expect(count()).toBe(0);
    });

    it('should update with a direct value', () =>
    {
        const [count, setCount] = createSignal(0);
        setCount(5);
        expect(count()).toBe(5);
    });

    it('should update with a function', () =>
    {
        const [count, setCount] = createSignal(10);
        setCount(prev => prev + 5);
        expect(count()).toBe(15);
    });

    it('should not notify if value is the same', () =>
    {
        const [count, setCount] = createSignal(0);

        const val1 = count();
        setCount(0);
        const val2 = count();

        expect(val1).toBe(val2);
    });

    it('should support custom equality', () =>
    {
        const [value, setValue] = createSignal(1.4, { equals: (prev, next) => Math.floor(prev) === Math.floor(next) });

        setValue(1.9);
        expect(value()).toBe(1.4);
    });

    it('should handle various types', () =>
    {
        const [str, setStr] = createSignal('hello');
        const [arr, setArr] = createSignal([1, 2, 3]);
        const [obj, setObj] = createSignal({ name: 'test' });

        setStr('world');
        expect(str()).toBe('world');

        setArr([4, 5]);
        expect(arr()).toEqual([4, 5]);

        setObj({ name: 'updated' });
        expect(obj()).toEqual({ name: 'updated' });
    });
});
