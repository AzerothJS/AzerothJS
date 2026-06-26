// @vitest-environment happy-dom
//
// Behavioral coverage for styleMap (style-binding.ts): camelCase->kebab-case
// conversion, static + getter values, null/undefined omission, numeric
// stringification, and reactive recomputation when bound as the `style` prop.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot } from '@azerothjs/reactivity';
import { h, styleMap } from '@azerothjs/renderer';

describe('styleMap — getter output', () =>
{
    it('returns a getter joining declarations with "; "', () =>
    {
        const getter = styleMap({ color: 'red', display: 'block' });
        expect(typeof getter).toBe('function');
        expect(getter()).toBe('color: red; display: block');
    });

    it('converts camelCase keys to kebab-case', () =>
    {
        const getter = styleMap({ backgroundColor: 'blue', fontSize: '16px' });
        expect(getter()).toBe('background-color: blue; font-size: 16px');
    });

    it('omits properties whose value is null or undefined', () =>
    {
        const getter = styleMap({ color: 'red', opacity: null, margin: undefined });
        expect(getter()).toBe('color: red');
    });

    it('stringifies numeric values as-is (no implicit unit)', () =>
    {
        const getter = styleMap({ opacity: 0, zIndex: 5 });
        expect(getter()).toBe('opacity: 0; z-index: 5');
    });

    it('evaluates function values on each call', () =>
    {
        let size = 10;
        const getter = styleMap({ width: () => `${ size }px` });
        expect(getter()).toBe('width: 10px');
        size = 20;
        expect(getter()).toBe('width: 20px');
    });
});

describe('styleMap — reactive binding in h()', () =>
{
    it('updates the inline style attribute when a value signal changes', () =>
    {
        createRoot((dispose) =>
        {
            const [size, setSize] = createSignal(10);
            const el = h('div', { style: styleMap({ width: () => `${ size() }px` }) });
            expect(el.style.width).toBe('10px');

            setSize(42);
            expect(el.style.width).toBe('42px');
            dispose();
        });
    });

    it('drops a property reactively when its value becomes null', () =>
    {
        createRoot((dispose) =>
        {
            const [hide, setHide] = createSignal(false);
            const el = h('div', { style: styleMap({ color: 'red', display: () => (hide() ? 'none' : null) }) });
            expect(el.style.display).toBe('');
            expect(el.style.color).toBe('red');

            setHide(true);
            expect(el.style.display).toBe('none');

            setHide(false);
            expect(el.style.display).toBe('');
            // The static property survives the toggle.
            expect(el.style.color).toBe('red');
            dispose();
        });
    });
});
