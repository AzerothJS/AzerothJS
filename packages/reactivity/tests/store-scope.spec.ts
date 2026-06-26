// @vitest-environment node
//
// Full behavioral coverage for store-scope (store-scope.ts): the per-render scope key
// that makes a store a client singleton but per-request-isolated under SSR.
import { describe, it, expect } from 'vitest';
import { getStoreScope, runInStoreScope } from '@azerothjs/reactivity';

describe('store-scope', () =>
{
    it('returns a stable default scope object across calls', () =>
    {
        const a = getStoreScope();
        const b = getStoreScope();
        expect(typeof a).toBe('object');
        expect(a).toBe(b);
    });

    it('runInStoreScope establishes a fresh scope for its callback and restores afterwards', () =>
    {
        const outer = getStoreScope();
        const inner = runInStoreScope(() => getStoreScope());
        expect(inner).not.toBe(outer);
        expect(getStoreScope()).toBe(outer);
    });

    it('isolates distinct runInStoreScope invocations (no cross-request leakage)', () =>
    {
        const first = runInStoreScope(() => getStoreScope());
        const second = runInStoreScope(() => getStoreScope());
        expect(first).not.toBe(second);
    });

    it('restores the parent scope when nested', () =>
    {
        runInStoreScope(() =>
        {
            const mid = getStoreScope();
            const deep = runInStoreScope(() => getStoreScope());
            expect(deep).not.toBe(mid);
            expect(getStoreScope()).toBe(mid);
        });
    });

    it('returns the callback result', () =>
    {
        expect(runInStoreScope(() => 7)).toBe(7);
    });
});
