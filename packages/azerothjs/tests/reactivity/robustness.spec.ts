// @vitest-environment node
//
// Runtime-robustness guarantees for the reactive primitives (v1 hardening pass): every public entry
// either normalizes its input or throws a PRECISE developer error, feedback loops fail fast with a
// clear cause instead of overflowing the stack, batches stay consistent across the flush, and a
// throwing disposer never strands its siblings.
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal, createMemo, createEffect, createResource, createRoot, batch, untrack, on, onCleanup
} from 'azerothjs';

describe('cyclic dependency detection', () =>
{
    it('a self-feeding effect throws a clear cyclic error, not a RangeError', () =>
    {
        expect(() =>
            createRoot((d) =>
            {
                const [x, setX] = createSignal(0);
                createEffect(() =>
                {
                    setX(x() + 1);
                });
                d();
            })
        ).toThrow(/[Cc]yclic effect/);
    });

    it('the cyclic error is not a stack overflow', () =>
    {
        let err: unknown;
        try
        {
            createRoot((d) =>
            {
                const [x, setX] = createSignal(0); createEffect(() => setX(x() + 1)); d();
            });
        }
        catch (e)
        {
            err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(RangeError);
    });

    it('a convergent self-write (set state then settle) is allowed', () =>
    {
        // Writing a DIFFERENT signal, or writing the same one to a value that settles, must NOT trip the
        // cyclic guard - only an unbounded loop does. Here the effect writes once then stops.
        const runs = vi.fn();
        createRoot((d) =>
        {
            const [trigger, setTrigger] = createSignal(0);
            const [count, setCount] = createSignal(0);
            createEffect(() =>
            {
                trigger(); runs(); if (count() === 0)
                {
                    setCount(1);
                }
            });
            setTrigger(1);
            d();
        });
        expect(runs).toHaveBeenCalled(); // did not throw
    });
});

describe('batch consistency', () =>
{
    it('an effect runs once over the final state when another effect writes its dep during flush', () =>
    {
        let bRuns = 0;
        createRoot((d) =>
        {
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            createEffect(() =>
            {
                a(); setB((x) => x + 1);
            }); // writes b (functional - no self-dep)
            createEffect(() =>
            {
                b(); bRuns++;
            });
            bRuns = 0;
            batch(() =>
            {
                setA(1); setB(100);
            });
            d();
        });
        expect(bRuns).toBe(1);
    });
});

describe('argument validation', () =>
{
    it('createEffect / createMemo / batch / untrack reject non-functions with a TypeError', () =>
    {

        const bad = (undefined as never);
        expect(() => createRoot((d) =>
        {
            createEffect(bad); d();
        })).toThrow(TypeError);
        expect(() => createRoot((d) =>
        {
            createMemo(bad); d();
        })).toThrow(TypeError);
        expect(() => batch(bad)).toThrow(TypeError);
        expect(() => untrack(bad)).toThrow(TypeError);
        expect(() => createRoot(bad)).toThrow(TypeError);
    });

    it('on() rejects a non-array dependency list', () =>
    {

        expect(() => createRoot((d) =>
        {
            on(123 as never, () =>
            {}); d();
        })).toThrow(TypeError);
    });

    it('the error message names the API and the bad type', () =>
    {

        expect(() => batch(42 as never)).toThrow(/batch expects a function, received a number/);
    });
});

describe('disposal isolation', () =>
{
    it('a throwing cleanup does not strand sibling effects', () =>
    {
        const laterCleanup = vi.fn();
        let dispose!: () => void;
        createRoot((d) =>
        {
            // Registered first => disposed LAST (reverse order); its cleanup must still run even though
            // an earlier-disposed sibling throws.
            createEffect(() =>
            {
                onCleanup(laterCleanup);
            });
            createEffect(() =>
            {
                onCleanup(() =>
                {
                    throw new Error('boom');
                });
            });
            dispose = d;
        });
        expect(() => dispose()).toThrow('boom');
        expect(laterCleanup).toHaveBeenCalledTimes(1);
    });
});

describe('createResource argument validation', () =>
{
    // The keyword's value is a verbatim expression the compiler never inspects, so a forgotten
    // thunk - `resource r = fetch(url)` - reached createResource as a PROMISE. It then simply
    // stayed loading forever with nothing reported anywhere.
    it('rejects a non-function fetcher with the shared message shape', () =>
    {
        expect(() => createRoot((d) =>
        {
            createResource(Promise.resolve(1) as never);
            d();
        })).toThrow(/createResource expects a function, received a Promise/);
    });

    it('rejects realistic forgotten-thunk expressions, not just literals', () =>
    {
        const pending = Promise.resolve({ ok: true });
        for (const bad of [pending, 5, 'url', null])
        {
            expect(() => createRoot((d) =>
            {
                createResource(bad as never);
                d();
            })).toThrow(TypeError);
        }
    });

    it('rejects the with-source mis-binding, which would otherwise fetch the SOURCE as data', () =>
    {
        // `resource r = 5 with { source: id }` emits createResource(() => id(), 5). Discrimination
        // is "is arg 2 a function", so 5 would demote the source thunk into the fetcher slot and
        // the resource would fetch the source's value. Silent wrong behaviour, not a hang.
        expect(() => createRoot((d) =>
        {
            createResource(() => 1, 5 as never);
            d();
        })).toThrow(/second argument, received a number/);
    });

    it('rejects a PROMISE in the options position - the shape the guard exists for', () =>
    {
        // `resource r = fetch(url) with { source: id }` emits createResource(() => id(), fetch(url)).
        // A promise is an object, so an "any object is options" test classified it as options, the
        // source thunk was promoted to fetcher, and the resource resolved to the source KEY and
        // served it as data - silently, and in SSR that wrong value is what gets hydrated.
        expect(() => createRoot((d) =>
        {
            createResource(() => 7, Promise.resolve('payload') as never);
            d();
        })).toThrow(/second argument, received a Promise/);
    });

    it('rejects an array in the options position', () =>
    {
        expect(() => createRoot((d) =>
        {
            createResource(() => 7, [1, 2] as never);
            d();
        })).toThrow(TypeError);
    });

    it('accepts every valid form', () =>
    {
        const dispose = createRoot((d) =>
        {
            createResource(async () => 'standalone');
            createResource(() => 1, async (n: number) => `source ${ n }`);
            createResource(async () => 'seeded', { initialValue: 'seed' });
            return d;
        });
        dispose();
    });
});
