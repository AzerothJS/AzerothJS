// @vitest-environment node
//
// Full behavioral coverage for catch-error (catch-error.ts): scoped error handling
// for synchronous throws and for effects/memos created within the scope (initial run
// AND re-runs), nested handler isolation, and the global onUncaughtError fallback.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createRoot,
    catchError,
    onUncaughtError
} from '@azerothjs/reactivity';

describe('catchError', () =>
{
    it('catches a synchronous throw inside the scope and returns undefined', () =>
    {
        let caught: unknown = null;
        const result = catchError(
            () =>
            {
                throw new Error('sync');
            },
            (err) =>
            {
                caught = err;
            }
        );
        expect((caught as Error).message).toBe('sync');
        expect(result).toBeUndefined();
    });

    it('returns the scope value when nothing throws', () =>
    {
        const result = catchError(() => 42, () => undefined);
        expect(result).toBe(42);
    });

    it('catches a throw from the initial run of an effect created in the scope', () =>
    {
        let caught: unknown = null;
        createRoot((dispose) =>
        {
            catchError(
                () =>
                {
                    createEffect(() =>
                    {
                        throw new Error('effect-init');
                    });
                },
                (err) =>
                {
                    caught = err;
                }
            );
            dispose();
        });
        expect((caught as Error).message).toBe('effect-init');
    });

    it('catches a throw from a RE-RUN of an effect created in the scope', () =>
    {
        const caught: string[] = [];
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            catchError(
                () =>
                {
                    createEffect(() =>
                    {
                        if (n() > 0)
                        {
                            throw new Error(`rerun-${ n() }`);
                        }
                    });
                },
                (err) =>
                {
                    caught.push((err as Error).message);
                }
            );
            expect(caught).toEqual([]);
            setN(1);
            expect(caught).toEqual(['rerun-1']);
            dispose();
        });
    });

    it('nested catchError routes to the nearest handler and restores the outer one', () =>
    {
        const outer: string[] = [];
        const inner: string[] = [];
        catchError(
            () =>
            {
                catchError(
                    () =>
                    {
                        throw new Error('inner');
                    },
                    (e) => inner.push((e as Error).message)
                );
                throw new Error('outer');
            },
            (e) => outer.push((e as Error).message)
        );
        expect(inner).toEqual(['inner']);
        expect(outer).toEqual(['outer']);
    });
});

describe('onUncaughtError', () =>
{
    it('receives an effect throw when no catchError is in scope, then can be uninstalled', () =>
    {
        const seen: Array<{ message: string; source: string }> = [];
        const uninstall = onUncaughtError((err, ctx) =>
        {
            seen.push({ message: (err as Error).message, source: ctx.source });
        });
        try
        {
            createRoot((dispose) =>
            {
                createEffect(() =>
                {
                    throw new Error('uncaught');
                });
                dispose();
            });
        }
        finally
        {
            uninstall();
        }
        expect(seen).toHaveLength(1);
        expect(seen[0].message).toBe('uncaught');
        expect(typeof seen[0].source).toBe('string');
    });
});
