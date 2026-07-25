// @vitest-environment node
//
// The ONE thunk-chain unwrap (internal): plain values pass through, getter chains
// collapse, and the depth bound stops a pathological self-returning getter instead of
// spinning forever. Three call sites (renderer holes, SSR serialization, co-range
// mount resolution) share this exact behavior by construction.
import { describe, it, expect } from 'vitest';
import { resolveThunks } from '@azerothjs/reactivity/internal';

describe('resolveThunks', () =>
{
    it('passes non-functions through and collapses getter chains', () =>
    {
        expect(resolveThunks(42)).toBe(42);
        expect(resolveThunks(() => 'x')).toBe('x');
        expect(resolveThunks(() => () => () => 'deep')).toBe('deep');
    });

    it('stops at the depth bound on a self-returning getter', () =>
    {
        const forever = (): unknown => forever;
        expect(typeof resolveThunks(forever)).toBe('function'); // bounded, not an infinite loop
    });
});
