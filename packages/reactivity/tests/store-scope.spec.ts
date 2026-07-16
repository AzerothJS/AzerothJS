// @vitest-environment node
//
// Full behavioral coverage for store-scope (store-scope.ts): the per-render scope key
// that makes a store a client singleton but per-request-isolated under SSR.
import { describe, it, expect, afterEach } from 'vitest';
import { getStoreScope, runInStoreScope, setStoreScopeResolver } from '@azerothjs/reactivity';

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

describe('setStoreScopeResolver: the async-context seam for server hosts', () =>
{
    afterEach(() => setStoreScopeResolver(null));

    it('is consulted when no explicit synchronous scope is active', () =>
    {
        const asyncScope = {};
        setStoreScopeResolver(() => asyncScope);
        expect(getStoreScope()).toBe(asyncScope);
    });

    it('an explicit runInStoreScope frame takes precedence (nested SSR isolates)', () =>
    {
        const asyncScope = {};
        setStoreScopeResolver(() => asyncScope);
        const inner = runInStoreScope(() => getStoreScope());
        expect(inner).not.toBe(asyncScope);
        expect(getStoreScope()).toBe(asyncScope); // restored after the frame
    });

    it('a resolver returning undefined falls through to the default scope', () =>
    {
        const fallback = getStoreScope();
        setStoreScopeResolver(() => undefined);
        expect(getStoreScope()).toBe(fallback);
    });

    it('null uninstalls', () =>
    {
        setStoreScopeResolver(() => ({}));
        setStoreScopeResolver(null);
        expect(getStoreScope()).toBe(getStoreScope()); // stable default again
    });
});
