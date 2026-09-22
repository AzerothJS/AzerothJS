// @vitest-environment node
//
// Full behavioral coverage for store-scope (store-scope.ts): the per-render scope key
// that makes a store a client singleton but per-request-isolated under SSR.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { getStoreScope, runInStoreScope } from 'azerothjs';
import { setStoreScopeResolver } from 'azerothjs/internal';

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

describe('a second copy', () =>
{
    // A separate evaluation of the module, standing in for an inlined or twice-loaded runtime.
    let second: typeof import('../../src/reactivity/store-scope.ts');

    beforeAll(async () =>
    {
        const copy = '../../src/reactivity/store-scope.ts?second';
        second = await import(copy) as typeof second;
    });

    afterEach(() => setStoreScopeResolver(null));

    it('is a separate evaluation', () =>
    {
        expect(second.getStoreScope).not.toBe(getStoreScope);
        expect(second.getStoreScope()).not.toBe(getStoreScope());
    });

    it('throws while a unit is open on the other copy', () =>
    {
        const unit = {};
        setStoreScopeResolver(() => unit);
        expect(getStoreScope()).toBe(unit);
        expect(() => second.getStoreScope()).toThrow(
            /getStoreScope: a second copy[\s\S]*external: \['azerothjs'\][\s\S]*two spellings of its path/
        );
    });

    it('keeps each copy on its own default outside every unit', () =>
    {
        const first = getStoreScope();
        const other = second.getStoreScope();
        setStoreScopeResolver(() => undefined);
        expect(getStoreScope()).toBe(first);
        expect(second.getStoreScope()).toBe(other);
        expect(other).not.toBe(first);
    });

    it('forgets a resolver once it is uninstalled', () =>
    {
        const other = second.getStoreScope();
        const resolver = (): object => ({});
        setStoreScopeResolver(resolver);
        setStoreScopeResolver(null);
        expect(second.getStoreScope()).toBe(other);
    });

    it('drops the entry of a resolver that has been collected', () =>
    {
        // A copy that was discarded leaves an entry whose resolver is gone.
        const registry = (globalThis as Record<symbol, Set<unknown> | undefined>)[Symbol.for('azerothjs.store-scope.resolvers')];
        const collected = { deref: (): undefined => undefined };
        registry?.add(collected);
        expect(() => second.getStoreScope()).not.toThrow();
        expect(registry?.has(collected)).toBe(false);
    });
});
