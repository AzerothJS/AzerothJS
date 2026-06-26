// @vitest-environment node
//
// Full behavioral coverage for render-mode (render-mode.ts): the dom/string/hydrate
// dispatch flag and the scoped runInMode override that the renderer and SSR rely on.
import { describe, it, expect } from 'vitest';
import {
    getRenderMode,
    isStringMode,
    isHydrating,
    runInMode
} from '@azerothjs/reactivity';

describe('render-mode', () =>
{
    it('defaults to dom mode', () =>
    {
        expect(getRenderMode()).toBe('dom');
        expect(isStringMode()).toBe(false);
        expect(isHydrating()).toBe(false);
    });

    it('runInMode("string") activates string mode for the callback only', () =>
    {
        const inside = runInMode('string', () =>
        {
            expect(getRenderMode()).toBe('string');
            expect(isStringMode()).toBe(true);
            expect(isHydrating()).toBe(false);
            return 'ok';
        });
        expect(inside).toBe('ok');
        // Restored afterwards.
        expect(getRenderMode()).toBe('dom');
        expect(isStringMode()).toBe(false);
    });

    it('runInMode("hydrate") activates hydrate mode for the callback only', () =>
    {
        runInMode('hydrate', () =>
        {
            expect(getRenderMode()).toBe('hydrate');
            expect(isHydrating()).toBe(true);
            expect(isStringMode()).toBe(false);
        });
        expect(getRenderMode()).toBe('dom');
        expect(isHydrating()).toBe(false);
    });

    it('restores the previous mode even through nesting', () =>
    {
        runInMode('string', () =>
        {
            expect(isStringMode()).toBe(true);
            runInMode('hydrate', () =>
            {
                expect(isHydrating()).toBe(true);
                expect(isStringMode()).toBe(false);
            });
            // Back to the outer string mode.
            expect(isStringMode()).toBe(true);
            expect(isHydrating()).toBe(false);
        });
        expect(getRenderMode()).toBe('dom');
    });

    it('restores mode even if the callback throws', () =>
    {
        expect(() =>
        {
            runInMode('string', () =>
            {
                throw new Error('boom');
            });
        }).toThrow('boom');
        expect(getRenderMode()).toBe('dom');
        expect(isStringMode()).toBe(false);
    });
});
