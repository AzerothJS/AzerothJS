// onUncaughtError: the throw-time last resort for reactive errors. The
// precedence contract: a catchError scope captured at creation always wins;
// the uncaught handler sees only what no scope claimed; with neither, the
// historical rethrow stands.

import { describe, it, expect, vi } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    catchError,
    onUncaughtError,
    type UncaughtErrorContext
} from '@azerothjs/reactivity';

describe('onUncaughtError', () =>
{
    it('receives errors from effects with no catchError scope, with source and name', () =>
    {
        const seen: { error: unknown; context: UncaughtErrorContext }[] = [];
        const uninstall = onUncaughtError((error, context) => seen.push({ error, context }));

        const [count, setCount] = createSignal(0);
        const failure = new Error('effect-boom');

        const dispose = createEffect(() =>
        {
            if (count() > 0)
            {
                throw failure;
            }
        }, { name: 'price-binding' });

        expect(seen).toHaveLength(0);

        // The write that triggers the throw must NOT see the exception.
        expect(() => setCount(1)).not.toThrow();
        expect(seen).toHaveLength(1);
        expect(seen[0].error).toBe(failure);
        expect(seen[0].context).toEqual({ source: 'effect', name: 'price-binding' });

        dispose();
        uninstall();
    });

    it('receives memo compute errors with source "memo"', () =>
    {
        const seen: UncaughtErrorContext[] = [];
        const uninstall = onUncaughtError((_error, context) => seen.push(context));

        const [n, setN] = createSignal(1);
        const inverse = createMemo(() =>
        {
            if (n() === 0)
            {
                throw new Error('divide by zero');
            }
            return 1 / n();
        });

        expect(inverse()).toBe(1);

        setN(0);
        expect(() => inverse()).not.toThrow();
        expect(seen).toHaveLength(1);
        expect(seen[0].source).toBe('memo');

        uninstall();
    });

    it('a catchError scope always wins over the uncaught handler', () =>
    {
        const scoped = vi.fn();
        const fallback = vi.fn();
        const uninstall = onUncaughtError(fallback);

        const [count, setCount] = createSignal(0);
        catchError(() =>
        {
            createEffect(() =>
            {
                if (count() > 0)
                {
                    throw new Error('scoped-boom');
                }
            });
        }, scoped);

        setCount(1);

        expect(scoped).toHaveBeenCalledOnce();
        expect(fallback).not.toHaveBeenCalled();

        uninstall();
    });

    it('unregistering restores the rethrow behavior', () =>
    {
        const uninstall = onUncaughtError(() => undefined);
        uninstall();

        expect(() => createEffect(() =>
        {
            throw new Error('back to throwing');
        })).toThrow('back to throwing');
    });
});
