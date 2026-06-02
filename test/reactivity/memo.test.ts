import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, createMemo } from '@azerothjs/core';

describe('createMemo()', () =>
{
    it('should compute initial value', () =>
    {
        const [count] = createSignal(5);
        const doubled = createMemo(() => count() * 2);

        expect(doubled()).toBe(10);
    });

    it('should recompute when dependencies change', () =>
    {
        const [count, setCount] = createSignal(3);
        const doubled = createMemo(() => count() * 2);

        expect(doubled()).toBe(6);

        setCount(10);
        expect(doubled()).toBe(20);
    });

    it('should work with multiple dependencies', () =>
    {
        const [price, setPrice] = createSignal(100);
        const [quantity, setQuantity] = createSignal(2);
        const total = createMemo(() => price() * quantity());

        expect(total()).toBe(200);

        setPrice(50);
        expect(total()).toBe(100);

        setQuantity(5);
        expect(total()).toBe(250);
    });

    it('should chain with other memos', () =>
    {
        const [count, setCount] = createSignal(2);
        const doubled = createMemo(() => count() * 2);
        const quadrupled = createMemo(() => doubled() * 2);

        expect(quadrupled()).toBe(8);

        setCount(5);
        expect(quadrupled()).toBe(20);
    });

    it('should work as dependency for effects', () =>
    {
        const [count, setCount] = createSignal(0);
        const doubled = createMemo(() => count() * 2);
        const results: number[] = [];

        createEffect(() =>
        {
            results.push(doubled());
        });

        expect(results).toEqual([0]);

        setCount(3);
        expect(results).toEqual([0, 6]);
    });

    it('should cache value between reads', () =>
    {
        const computeFn = vi.fn((x: number) => x * 2);
        const [count] = createSignal(5);
        const doubled = createMemo(() => computeFn(count()));

        // First read triggers compute
        doubled();
        // Second read should use cache
        doubled();
        doubled();

        expect(computeFn).toHaveBeenCalledTimes(1);
    });

    it('should handle boolean computations', () =>
    {
        const [count, setCount] = createSignal(0);
        const isPositive = createMemo(() => count() > 0);
        const isEven = createMemo(() => count() % 2 === 0);

        expect(isPositive()).toBe(false);
        expect(isEven()).toBe(true);

        setCount(3);
        expect(isPositive()).toBe(true);
        expect(isEven()).toBe(false);
    });

    it('should handle string computations', () =>
    {
        const [first, setFirst] = createSignal('John');
        const [last, _setLast] = createSignal('Doe');
        const fullName = createMemo(() => `${ first() } ${ last() }`);

        expect(fullName()).toBe('John Doe');

        setFirst('Jane');
        expect(fullName()).toBe('Jane Doe');
    });

    it('should not invoke a custom equals with the initial placeholder', () =>
    {
        const [id, setId] = createSignal(1);

        // A custom equals that dereferences its arguments would
        // throw if it ever received the initial `undefined`.
        const user = createMemo(
            () => ({ id: id(), name: 'A' }),
            { equals: (a, b) => a.id === b.id }
        );

        expect(user()).toEqual({ id: 1, name: 'A' });

        // Same id under the custom equals: value is NOT replaced.
        const before = user();
        setId(1);
        expect(user()).toBe(before);

        // Different id: recomputed.
        setId(2);
        expect(user()).toEqual({ id: 2, name: 'A' });
    });

    it('should store a function value verbatim, not invoke it as an updater', () =>
    {
        const [enabled, setEnabled] = createSignal(true);
        const noop = (): string => 'noop';
        const handler = (): string => 'handler';

        const current = createMemo<() => string>(() => (enabled() ? handler : noop));

        // The memo must return the function itself, untouched.
        expect(current()).toBe(handler);
        expect(current()()).toBe('handler');

        setEnabled(false);
        expect(current()).toBe(noop);
    });
});
