// @vitest-environment node
//
// Glitch-freedom: every top-level write runs inside an implicit flush, so an effect
// downstream of a diamond (one signal feeding several memos the effect reads) fires
// exactly ONCE per write and never observes mixed-generation state (one memo fresh,
// another stale). This was the defining reactive-core defect of the 1.0 review: a
// plain `set(2)` used to fire the diamond effect twice, first on [new, STALE]. The
// flush stays fully synchronous - effects have run by the time the setter returns -
// and batch() still extends the window across multiple writes (and now returns the
// body's value).
import { describe, it, expect } from 'vitest';
import { createSignal, createMemo, createEffect, createRoot, batch, untrack } from 'azerothjs';

describe('glitch-free writes (the diamond)', () =>
{
    it('a plain write through a diamond fires the effect ONCE, on consistent state', () =>
    {
        const [s, setS] = createSignal(1);
        const a = createMemo(() => s() * 10);
        const b = createMemo(() => s() * 100);
        const observed: Array<[number, number]> = [];
        createRoot(() =>
        {
            createEffect(() =>
            {
                observed.push([a(), b()]);
            });
        });
        expect(observed).toEqual([[10, 100]]);

        observed.length = 0;
        setS(2); // NO batch() - a bare write must already be glitch-free
        expect(observed).toEqual([[20, 200]]);                                  // one fire
        expect(observed.some(([x, y]) => x / 10 !== y / 100)).toBe(false);      // never mixed generations
    });

    it('the flush is synchronous: effects have run by the time the setter returns', () =>
    {
        const [s, setS] = createSignal(0);
        let seen = -1;
        createRoot(() =>
        {
            createEffect(() =>
            {
                seen = s();
            });
        });
        setS(7);
        expect(seen).toBe(7); // no microtask, no await - the write call itself flushed
    });

    it('a deeper diamond (memo-of-memo on one arm) still fires once, consistent', () =>
    {
        const [s, setS] = createSignal(1);
        const a = createMemo(() => s() + 1);
        const aa = createMemo(() => a() * 2);   // longer arm
        const b = createMemo(() => s() * 100);  // shorter arm
        const observed: Array<[number, number]> = [];
        createRoot(() =>
        {
            createEffect(() =>
            {
                observed.push([aa(), b()]);
            });
        });
        observed.length = 0;
        setS(2);
        expect(observed).toEqual([[6, 200]]);
    });

    it('an equal-value recompute through a memo still skips the effect entirely', () =>
    {
        const [s, setS] = createSignal(1);
        const sign = createMemo(() => (s() > 0 ? 'pos' : 'neg'));
        let runs = 0;
        createRoot(() =>
        {
            createEffect(() =>
            {
                sign();
                runs++;
            });
        });
        expect(runs).toBe(1);
        setS(5); // sign() recomputes equal - the version cutoff must still hold
        expect(runs).toBe(1);
        setS(-1);
        expect(runs).toBe(2);
    });

    it('TWO sequential writes still fire the shared effect twice - batch() remains the grouping tool', () =>
    {
        const [x, setX] = createSignal(0);
        const [y, setY] = createSignal(0);
        let runs = 0;
        createRoot(() =>
        {
            createEffect(() =>
            {
                x();
                y();
                runs++;
            });
        });
        runs = 0;
        setX(1);
        setY(1);
        expect(runs).toBe(2); // each write is its OWN flush - consistent, but not coalesced

        runs = 0;
        batch(() =>
        {
            setX(2);
            setY(2);
        });
        expect(runs).toBe(1); // batch() coalesces the group
    });

    it('batch() returns the body\'s value', () =>
    {
        const [s, setS] = createSignal(1);
        const result = batch(() =>
        {
            setS(2);
            return untrack(() => s()) * 10;
        });
        expect(result).toBe(20);
    });

    it('a convergent self-write inside an effect still settles (no loop, no double-count)', () =>
    {
        const [n, setN] = createSignal(0);
        const [clamped, setClamped] = createSignal(0);
        let runs = 0;
        createRoot(() =>
        {
            createEffect(() =>
            {
                runs++;
                const v = n();
                if (v > 10)
                {
                    setClamped(10); // write from inside the flush - defers to the next round
                }
                else
                {
                    setClamped(v);
                }
            });
        });
        setN(42);
        expect(untrack(() => clamped())).toBe(10);
        expect(runs).toBe(2); // initial + one re-run for the write; converged
    });

    it('a divergent feedback loop is still caught with a precise error', () =>
    {
        const [n, setN] = createSignal(0);
        expect(() =>
        {
            createRoot(() =>
            {
                createEffect(() =>
                {
                    setN(n() + 1); // reads and writes the same signal - never settles
                });
            });
        }).toThrow(/keeps? writing a signal it (reads|depends on)|Cyclic effect/);
    });
});
