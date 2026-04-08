import { describe, it, expect } from 'vitest';
import { createSignal, classList } from '@quantum/core';

describe('classList()', () =>
{
    it('should include classes with true conditions', () =>
    {
        const result = classList({
            'btn': true,
            'btn-primary': true
        });

        expect(result()).toBe('btn btn-primary');
    });

    it('should exclude classes with false conditions', () =>
    {
        const result = classList({
            'btn': true,
            'btn-primary': false,
            'btn-disabled': false
        });

        expect(result()).toBe('btn');
    });

    it('should support reactive conditions (signal getters)', () =>
    {
        const [isActive, setIsActive] = createSignal(false);
        const [isLarge, setIsLarge] = createSignal(true);

        const result = classList({
            'btn': true,
            'btn-active': isActive,
            'btn-lg': isLarge
        });

        expect(result()).toBe('btn btn-lg');

        setIsActive(true);
        expect(result()).toBe('btn btn-active btn-lg');

        setIsLarge(false);
        expect(result()).toBe('btn btn-active');
    });

    it('should support array syntax with strings', () =>
    {
        const result = classList([
            'card',
            'shadow'
        ]);

        expect(result()).toBe('card shadow');
    });

    it('should support array syntax with mixed strings and objects', () =>
    {
        const [isHovered] = createSignal(true);

        const result = classList([
            'card',
            { 'card-hover': isHovered },
            { 'card-rounded': true }
        ]);

        expect(result()).toBe('card card-hover card-rounded');
    });

    it('should return empty string when no classes are active', () =>
    {
        const result = classList({
            'a': false,
            'b': false
        });

        expect(result()).toBe('');
    });
});
