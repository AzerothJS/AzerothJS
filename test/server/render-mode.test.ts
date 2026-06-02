import { describe, it, expect } from 'vitest';
import { getRenderMode, isStringMode, isHydrating, runInMode } from '@azerothjs/reactivity';
import { h } from '@azerothjs/renderer';

describe('render mode', () =>
{
    it('defaults to dom', () =>
    {
        expect(getRenderMode()).toBe('dom');
        expect(isStringMode()).toBe(false);
        expect(isHydrating()).toBe(false);
    });

    it('activates a mode for the duration of runInMode', () =>
    {
        const inside = runInMode('string', () => getRenderMode());
        expect(inside).toBe('string');
        expect(getRenderMode()).toBe('dom');
    });

    it('nests and restores correctly', () =>
    {
        runInMode('string', () =>
        {
            expect(getRenderMode()).toBe('string');
            runInMode('hydrate', () =>
            {
                expect(getRenderMode()).toBe('hydrate');
            });
            expect(getRenderMode()).toBe('string');
        });
        expect(getRenderMode()).toBe('dom');
    });

    it('resets the mode even when the body throws', () =>
    {
        expect(() => runInMode('string', () =>
        {
            throw new Error('boom');
        })).toThrow('boom');
        expect(getRenderMode()).toBe('dom');
    });

    it('leaves the DOM path untouched outside runInMode', () =>
    {
        const el = h('div', { id: 'x' }, 'hi');
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.tagName).toBe('DIV');
        expect(el.id).toBe('x');
        expect(el.textContent).toBe('hi');
    });
});
