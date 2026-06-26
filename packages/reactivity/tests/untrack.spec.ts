// @vitest-environment node
//
// Full behavioral coverage for untrack (untrack.ts): reading without subscribing,
// return-value pass-through, nesting, and that writes inside untrack still notify.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createRoot,
    untrack,
    subscriberCount
} from '@azerothjs/reactivity';

describe('untrack', () =>
{
    it('reads a signal without subscribing the surrounding effect', () =>
    {
        createRoot((dispose) =>
        {
            const [tracked, setTracked] = createSignal(0);
            const [hidden, setHidden] = createSignal(0);
            let runs = 0;
            createEffect(() =>
            {
                tracked();
                untrack(() => hidden());
                runs++;
            });
            expect(runs).toBe(1);
            setHidden(99);
            expect(runs).toBe(1);
            setTracked(1);
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('returns the inner function result', () =>
    {
        const [n] = createSignal(42);
        const value = untrack(() => n() + 1);
        expect(value).toBe(43);
    });

    it('does not subscribe even an effect that reads ONLY through untrack', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            let runs = 0;
            createEffect(() =>
            {
                untrack(() => n());
                runs++;
            });
            expect(runs).toBe(1);
            expect(subscriberCount(n)).toBe(0);
            setN(1);
            expect(runs).toBe(1);
            dispose();
        });
    });

    it('nests: an inner tracked read after restoring context still subscribes', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            let runs = 0;
            createEffect(() =>
            {
                untrack(() =>
                {
                    a(); // untracked
                });
                b(); // tracked again outside untrack
                runs++;
            });
            setA(1);
            expect(runs).toBe(1);
            setB(1);
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('writes performed inside untrack still notify other subscribers', () =>
    {
        createRoot((dispose) =>
        {
            const [source, setSource] = createSignal(0);
            let observed = -1;
            createEffect(() =>
            {
                observed = source();
            });
            untrack(() =>
            {
                setSource(5);
            });
            expect(observed).toBe(5);
            dispose();
        });
    });
});
