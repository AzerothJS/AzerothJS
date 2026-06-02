import { describe, it, expect, vi } from 'vitest';
import { createRoot, createEffect, createSignal, onCleanup, onRootDispose } from '@azerothjs/core';

describe('onRootDispose', () =>
{
    it('should fire when the surrounding createRoot is disposed', () =>
    {
        const cb = vi.fn();

        createRoot((dispose) =>
        {
            onRootDispose(cb);
            expect(cb).not.toHaveBeenCalled();

            dispose();
            expect(cb).toHaveBeenCalledOnce();
        });
    });

    it('should fire exactly once even if dispose is called twice', () =>
    {
        const cb = vi.fn();

        createRoot((dispose) =>
        {
            onRootDispose(cb);
            dispose();
            dispose();
        });

        expect(cb).toHaveBeenCalledOnce();
    });

    it('should fire all callbacks in LIFO order', () =>
    {
        const log: string[] = [];

        createRoot((dispose) =>
        {
            onRootDispose(() => log.push('A'));
            onRootDispose(() => log.push('B'));
            onRootDispose(() => log.push('C'));

            dispose();
        });

        expect(log).toEqual(['C', 'B', 'A']);
    });

    it('should be a safe no-op when called outside a root', () =>
    {
        const cb = vi.fn();

        // Calling outside a root must not throw and must not run
        // the callback at any point.
        expect(() => onRootDispose(cb)).not.toThrow();
        expect(cb).not.toHaveBeenCalled();
    });

    it('should give nested roots independent ownership of their callbacks', () =>
    {
        const outerCb = vi.fn();
        const innerCb = vi.fn();

        createRoot((disposeOuter) =>
        {
            onRootDispose(outerCb);

            createRoot((disposeInner) =>
            {
                onRootDispose(innerCb);

                // Disposing the inner root must fire only the inner
                // callback - the outer one must remain pending.
                disposeInner();
                expect(innerCb).toHaveBeenCalledOnce();
                expect(outerCb).not.toHaveBeenCalled();
            });

            // Disposing the outer root now fires only the outer
            // callback. The inner one was already drained.
            disposeOuter();
            expect(outerCb).toHaveBeenCalledOnce();
            expect(innerCb).toHaveBeenCalledOnce();
        });
    });

    it('should coexist with effect cleanups in the same root', () =>
    {
        const log: string[] = [];
        const [count, setCount] = createSignal(0);

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                count();
                onCleanup(() => log.push('effect-cleanup'));
            });

            onRootDispose(() => log.push('root-dispose'));

            // Re-running the effect runs its onCleanup, but must NOT
            // run the root-dispose callback.
            setCount(1);
            expect(log).toEqual(['effect-cleanup']);

            // Disposing the root runs all disposers in LIFO order.
            // The effect was registered first, then the onRootDispose
            // callback, so on dispose:
            //   1. onRootDispose callback fires first
            //   2. effect dispose runs, which fires the effect's
            //      latest onCleanup (registered when count=1 ran)
            // ...each exactly once.
            dispose();
            expect(log).toEqual(['effect-cleanup', 'root-dispose', 'effect-cleanup']);
        });
    });
});
