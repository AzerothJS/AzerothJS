import { describe, it, expect } from 'vitest';
import { createSignal, styleMap } from '@azerothjs/core';

describe('styleMap()', () =>
{
    it('should convert static values to style string', () =>
    {
        const result = styleMap({
            color: 'red',
            'font-size': '16px'
        });

        expect(result()).toBe('color: red; font-size: 16px');
    });

    it('should support reactive values', () =>
    {
        const [color, setColor] = createSignal('blue');

        const result = styleMap({
            color: color,
            'font-weight': 'bold'
        });

        expect(result()).toBe('color: blue; font-weight: bold');

        setColor('green');
        expect(result()).toBe('color: green; font-weight: bold');
    });

    it('should skip null and undefined values', () =>
    {
        const result = styleMap({
            color: 'red',
            display: null,
            opacity: undefined
        });

        expect(result()).toBe('color: red');
    });

    it('should support reactive null (conditional styles)', () =>
    {
        const [isHidden, setIsHidden] = createSignal(false);

        const result = styleMap({
            display: () => isHidden() ? 'none' : null,
            color: 'red'
        });

        expect(result()).toBe('color: red');

        setIsHidden(true);
        expect(result()).toBe('display: none; color: red');
    });

    it('should convert camelCase to kebab-case', () =>
    {
        const result = styleMap({
            fontSize: '16px',
            backgroundColor: 'blue',
            borderRadius: '8px'
        });

        expect(result()).toBe('font-size: 16px; background-color: blue; border-radius: 8px');
    });

    it('should handle number values', () =>
    {
        const result = styleMap({
            opacity: 0.5,
            'z-index': 100
        });

        expect(result()).toBe('opacity: 0.5; z-index: 100');
    });

    it('should return empty string when all values are null', () =>
    {
        const result = styleMap({
            display: null,
            color: undefined
        });

        expect(result()).toBe('');
    });
});
