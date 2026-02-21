import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, createMemo } from '../src';

describe('createMemo', () =>
{
    it('should compute the initial value', () =>
    {
        const [count] = createSignal(5);
        const doubled = createMemo(() => count() * 2);

        expect(doubled()).toBe(10);
    });

    it('should update when its dependency changes', () =>
    {
        const [count, setCount] = createSignal(3);
        const doubled = createMemo(() => count() * 2);

        expect(doubled()).toBe(6);

        setCount(10);
        expect(doubled()).toBe(20);

        setCount(0);
        expect(doubled()).toBe(0);
    });

    it('should chain with other memos', () =>
    {
        const [price, setPrice] = createSignal(100);
        const tax = createMemo(() => price() * 0.2);
        const total = createMemo(() => price() + tax());

        expect(tax()).toBe(20);
        expect(total()).toBe(120);

        setPrice(200);
        expect(tax()).toBe(40);
        expect(total()).toBe(240);
    });

    it('should work inside effects', () =>
    {
        const [count, setCount] = createSignal(1);
        const doubled = createMemo(() => count() * 2);
        const values: number[] = [];

        createEffect(() =>
        {
            values.push(doubled());
        });

        expect(values).toEqual([2]);

        setCount(2);
        expect(values).toEqual([2, 4]);

        setCount(3);
        expect(values).toEqual([2, 4, 6]);
    });

    it('should work with multiple dependencies', () =>
    {
        const [a, setA] = createSignal(1);
        const [b, setB] = createSignal(2);
        const sum = createMemo(() => a() + b());

        expect(sum()).toBe(3);

        setA(10);
        expect(sum()).toBe(12);

        setB(20);
        expect(sum()).toBe(30);
    });

    it('should work with string computations', () =>
    {
        const [firstName, setFirstName] = createSignal('John');
        const [lastName, setLastName] = createSignal('Doe');
        const fullName = createMemo(() => `${ firstName() } ${ lastName() }`);

        expect(fullName()).toBe('John Doe');

        setFirstName('Jane');
        expect(fullName()).toBe('Jane Doe');

        setLastName('Smith');
        expect(fullName()).toBe('Jane Smith');
    });

    it('should work with array computations', () =>
    {
        const [numbers, setNumbers] = createSignal([1, 2, 3, 4, 5]);
        const sum = createMemo(() => numbers().reduce((a, b) => a + b, 0));
        const count = createMemo(() => numbers().length);

        expect(sum()).toBe(15);
        expect(count()).toBe(5);

        setNumbers([10, 20, 30]);
        expect(sum()).toBe(60);
        expect(count()).toBe(3);
    });

    it('should be read-only (no setter returned)', () =>
    {
        const [count] = createSignal(5);
        const doubled = createMemo(() => count() * 2);

        expect(typeof doubled).toBe('function');

        expect(typeof doubled()).toBe('number');
    });
});
