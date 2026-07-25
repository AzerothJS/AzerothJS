// @vitest-environment node
//
// The Owner node: createRoot now builds a tree node ({ disposers, parent, context,
// errorHandler }) instead of a bare disposer array. getOwner/runWithOwner make async
// continuations OWNED (the pre-1.0 review's top ownership gap: anything created in an
// async callback was unowned and leaked), and createContext/provideContext/useContext
// give the ownership tree dependency injection - the primitive component libraries
// need instead of module singletons (which leak across SSR requests).
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal, createEffect, createRoot, catchError,
    getOwner, runWithOwner,
    createContext, provideContext, useContext
} from 'azerothjs';

describe('the owner tree', () =>
{
    it('getOwner is null outside any root, non-null inside, and restored after', () =>
    {
        expect(getOwner()).toBeNull();
        createRoot(() =>
        {
            expect(getOwner()).not.toBeNull();
        });
        expect(getOwner()).toBeNull();
    });

    it('nested roots chain through parent', () =>
    {
        createRoot(() =>
        {
            const outer = getOwner();
            createRoot(() =>
            {
                expect(getOwner()?.parent).toBe(outer);
            });
        });
    });

    it('runWithOwner makes an async-continuation effect OWNED: disposing the root kills it', () =>
    {
        const [n, setN] = createSignal(0);
        let observed = -1;

        let dispose!: () => void;
        const owner = createRoot((d) =>
        {
            dispose = d;
            return getOwner();
        });

        // Simulates the after-await continuation: the synchronous scope is long gone.
        expect(getOwner()).toBeNull();
        runWithOwner(owner, () =>
        {
            createEffect(() =>
            {
                observed = n();
            });
        });

        setN(1);
        expect(observed).toBe(1); // live and reactive

        dispose();
        setN(2);
        expect(observed).toBe(1); // disposed WITH the root - not leaked
    });

    it('runWithOwner returns the body value and restores the previous owner', () =>
    {
        const result = createRoot(() =>
        {
            const before = getOwner();
            const out = runWithOwner(null, () =>
            {
                expect(getOwner()).toBeNull();
                return 42;
            });
            expect(getOwner()).toBe(before);
            return out;
        });
        expect(result).toBe(42);
    });

    it('runWithOwner restores the owner\'s error routing for effects created in the continuation', () =>
    {
        const handler = vi.fn();
        const owner = catchError(
            () => createRoot(() => getOwner()),
            handler
        );

        const [n, setN] = createSignal(0);
        runWithOwner(owner ?? null, () =>
        {
            createEffect(() =>
            {
                if (n() === 1)
                {
                    throw new Error('continuation boom');
                }
            });
        });

        setN(1);
        expect(handler).toHaveBeenCalledOnce(); // routed to the boundary the OWNER was created in
    });
});

describe('context', () =>
{
    it('provides down the tree, shadows nearer, isolates siblings, defaults when absent', () =>
    {
        const Theme = createContext<string>('light');

        createRoot(() =>
        {
            provideContext(Theme, 'dark');

            createRoot(() =>
            {
                expect(useContext(Theme)).toBe('dark');      // inherited from the outer scope

                provideContext(Theme, 'solarized');
                expect(useContext(Theme)).toBe('solarized'); // nearer provide shadows
            });

            createRoot(() =>
            {
                expect(useContext(Theme)).toBe('dark');      // sibling shadowing did not leak
            });
        });

        expect(useContext(Theme)).toBe('light');             // no owner -> default
    });

    it('context values reach async continuations through runWithOwner', () =>
    {
        const User = createContext<string>();
        const owner = createRoot(() =>
        {
            provideContext(User, 'jaina');
            return getOwner();
        });

        const seen = runWithOwner(owner, () => useContext(User));
        expect(seen).toBe('jaina');
    });

    it('provideContext outside any owner throws with guidance', () =>
    {
        const Ctx = createContext<number>(0, 'settings');
        expect(() => provideContext(Ctx, 1)).toThrow(/outside any ownership scope/);
    });

    it('disposing a root frees its provided context', () =>
    {
        const Ctx = createContext<string>();
        let dispose!: () => void;
        const owner = createRoot((d) =>
        {
            dispose = d;
            provideContext(Ctx, 'payload');
            return getOwner();
        });

        expect(runWithOwner(owner, () => useContext(Ctx))).toBe('payload');
        dispose();
        expect(runWithOwner(owner, () => useContext(Ctx))).toBeUndefined(); // map cleared with the scope
    });
});
