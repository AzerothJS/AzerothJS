import { describe, it, expect } from 'vitest';
import { createSignal } from '../src';

describe('createSignal', () =>
{
    it('should return the initial value', () =>
    {
        const [count] = createSignal(0);
        expect(count()).toBe(0);
    });

    it('should update the value with a direct value', () =>
    {
        const [count, setCount] = createSignal(0);
        setCount(5);
        expect(count()).toBe(5);
    });

    it('should update the value with a function', () =>
    {
        const [count, setCount] = createSignal(10);
        setCount(prev => prev + 5);
        expect(count()).toBe(15);
    });

    it('should work with strings', () =>
    {
        const [name, setName] = createSignal('Alice');
        expect(name()).toBe('Alice');
        setName('Bob');
        expect(name()).toBe('Bob');
    });

    it('should work with booleans', () =>
    {
        const [isOpen, setIsOpen] = createSignal(false);
        expect(isOpen()).toBe(false);
        setIsOpen(true);
        expect(isOpen()).toBe(true);
    });

    it('should work with arrays', () =>
    {
        const [items, setItems] = createSignal<string[]>([]);
        expect(items()).toEqual([]);
        setItems(['a', 'b']);
        expect(items()).toEqual(['a', 'b']);
    });
});
