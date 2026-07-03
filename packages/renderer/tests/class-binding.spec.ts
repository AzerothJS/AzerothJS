// @vitest-environment happy-dom
//
// Behavioral coverage for classList (class-binding.ts): object + array syntax,
// static vs getter conditions, space-joining, and reactive recomputation when
// bound as the `class` prop in h().
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot } from '@azerothjs/reactivity';
import { h, classList } from '@azerothjs/renderer';

describe('classList - getter output', () =>
{
    it('returns a getter that joins truthy object keys with single spaces', () =>
    {
        const getter = classList({ btn: true, primary: true, disabled: false });
        expect(typeof getter).toBe('function');
        expect(getter()).toBe('btn primary');
    });

    it('omits falsey conditions', () =>
    {
        const getter = classList({ a: false, b: true, c: false });
        expect(getter()).toBe('b');
    });

    it('evaluates function conditions on each call', () =>
    {
        let active = false;
        const getter = classList({ box: true, active: () => active });
        expect(getter()).toBe('box');
        active = true;
        expect(getter()).toBe('box active');
    });

    it('supports array syntax mixing plain strings and condition objects', () =>
    {
        const getter = classList(['card', 'shadow', { hover: true, hidden: false }]);
        expect(getter()).toBe('card shadow hover');
    });

    it('does not de-duplicate repeated class names (author input is trusted)', () =>
    {
        const getter = classList(['x', { x: true }]);
        expect(getter()).toBe('x x');
    });
});

describe('classList - reactive binding in h()', () =>
{
    it('toggles a single class when its condition signal flips', () =>
    {
        createRoot((dispose) =>
        {
            const [active, setActive] = createSignal(false);
            const el = h('div', { class: classList({ box: true, active }) });
            expect(el.classList.contains('box')).toBe(true);
            expect(el.classList.contains('active')).toBe(false);

            setActive(true);
            expect(el.classList.contains('active')).toBe(true);

            setActive(false);
            expect(el.classList.contains('active')).toBe(false);
            // The always-on class is preserved across toggles.
            expect(el.classList.contains('box')).toBe(true);
            dispose();
        });
    });

    it('tracks only the conditions that are actually read', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(false);
            const [b, setB] = createSignal(false);
            const el = h('div', { class: classList({ a, b }) });
            expect(el.getAttribute('class')).toBe('');

            setA(true);
            expect(el.getAttribute('class')).toBe('a');
            setB(true);
            expect(el.getAttribute('class')).toBe('a b');
            setA(false);
            expect(el.getAttribute('class')).toBe('b');
            dispose();
        });
    });
});
