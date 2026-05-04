import { describe, it, expect, vi } from 'vitest';
import {
    createRoot,
    createSignal,
    createEffect,
    createMemo,
    catchError
} from '@azerothjs/core';

describe('catchError', () =>
{
    it('returns fn\'s value when no error is thrown', () =>
    {
        createRoot((dispose) =>
        {
            const handler = vi.fn();

            const value = catchError(() => 42, handler);

            expect(value).toBe(42);
            expect(handler).not.toHaveBeenCalled();

            dispose();
        });
    });

    it('routes a synchronous throw inside fn to the handler', () =>
    {
        createRoot((dispose) =>
        {
            const handler = vi.fn();
            const failure = new Error('boom');

            const value = catchError(() =>
            {
                throw failure;
            }, handler);

            expect(value).toBeUndefined();
            expect(handler).toHaveBeenCalledOnce();
            expect(handler).toHaveBeenCalledWith(failure);

            dispose();
        });
    });

    it('catches an error thrown during an effect\'s initial run', () =>
    {
        createRoot((dispose) =>
        {
            const handler = vi.fn();
            const failure = new Error('effect-init');

            catchError(() =>
            {
                createEffect(() =>
                {
                    throw failure;
                });
            }, handler);

            expect(handler).toHaveBeenCalledOnce();
            expect(handler).toHaveBeenCalledWith(failure);

            dispose();
        });
    });

    it('catches an error thrown during an effect\'s re-run after a signal change', () =>
    {
        createRoot((dispose) =>
        {
            const handler = vi.fn();
            const [count, setCount] = createSignal(0);

            catchError(() =>
            {
                createEffect(() =>
                {
                    if (count() > 0)
                    {
                        throw new Error(`count=${ count() }`);
                    }
                });
            }, handler);

            // Initial run: count=0, no throw, no handler call.
            expect(handler).not.toHaveBeenCalled();

            // Re-run: count=1, throws — handler captured at
            // CONSTRUCTION fires even though catchError's body
            // already returned.
            setCount(1);
            expect(handler).toHaveBeenCalledOnce();
            expect((handler.mock.calls[0][0] as Error).message).toBe('count=1');

            // Another re-run, another throw, another handler call.
            setCount(2);
            expect(handler).toHaveBeenCalledTimes(2);
            expect((handler.mock.calls[1][0] as Error).message).toBe('count=2');

            dispose();
        });
    });

    it('catches an error thrown inside a memo\'s compute', () =>
    {
        createRoot((dispose) =>
        {
            const handler = vi.fn();
            const failure = new Error('memo-throw');

            catchError(() =>
            {
                // The memo's underlying effect throws on first
                // recompute — must route through the captured
                // handler.
                createMemo(() =>
                {
                    throw failure;
                });
            }, handler);

            expect(handler).toHaveBeenCalledOnce();
            expect(handler).toHaveBeenCalledWith(failure);

            dispose();
        });
    });

    it('routes errors from a nested scope to the inner handler, not the outer', () =>
    {
        createRoot((dispose) =>
        {
            const outerHandler = vi.fn();
            const innerHandler = vi.fn();
            const failure = new Error('inner-throw');

            catchError(() =>
            {
                catchError(() =>
                {
                    createEffect(() =>
                    {
                        throw failure;
                    });
                }, innerHandler);
            }, outerHandler);

            expect(innerHandler).toHaveBeenCalledOnce();
            expect(innerHandler).toHaveBeenCalledWith(failure);
            expect(outerHandler).not.toHaveBeenCalled();

            dispose();
        });
    });

    it('routes to the outer handler for effects created BEFORE the inner scope opens', () =>
    {
        createRoot((dispose) =>
        {
            const outerHandler = vi.fn();
            const innerHandler = vi.fn();
            const [tick, setTick] = createSignal(0);

            catchError(() =>
            {
                // This effect was created while the OUTER handler
                // was the only one active. It captures the outer
                // handler at construction.
                createEffect(() =>
                {
                    if (tick() > 0) throw new Error('from-outer-effect');
                });

                // This effect is inside the inner scope and
                // captures the inner handler.
                catchError(() =>
                {
                    createEffect(() =>
                    {
                        if (tick() > 0) throw new Error('from-inner-effect');
                    });
                }, innerHandler);
            }, outerHandler);

            // Trigger both effects.
            setTick(1);

            expect(outerHandler).toHaveBeenCalledOnce();
            expect((outerHandler.mock.calls[0][0] as Error).message).toBe('from-outer-effect');

            expect(innerHandler).toHaveBeenCalledOnce();
            expect((innerHandler.mock.calls[0][0] as Error).message).toBe('from-inner-effect');

            dispose();
        });
    });

    it('lets effects created OUTSIDE any catchError throw normally', () =>
    {
        createRoot((dispose) =>
        {
            // No catchError on the stack. Throwing inside the
            // effect must propagate as before — preserves the
            // pre-catchError contract for every existing call site.
            expect(() =>
            {
                createEffect(() =>
                {
                    throw new Error('uncaught');
                });
            }).toThrow('uncaught');

            dispose();
        });
    });
});
