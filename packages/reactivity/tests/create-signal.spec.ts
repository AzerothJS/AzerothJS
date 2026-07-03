// @vitest-environment node
//
// Full behavioral coverage for createSignal + subscriberCount (create-signal.ts).
// Real graph, no mocks; DOM-less so any hidden DOM dependency would surface.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    subscriberCount
} from '@azerothjs/reactivity';

describe('createSignal - value semantics', () =>
{
    it('returns a [getter, setter] tuple and reads the initial value', () =>
    {
        const signal = createSignal(42);
        expect(Array.isArray(signal)).toBe(true);
        expect(signal).toHaveLength(2);
        const [value, setValue] = signal;
        expect(typeof value).toBe('function');
        expect(typeof setValue).toBe('function');
        expect(value()).toBe(42);
    });

    it('reflects a direct write on the next read', () =>
    {
        const [value, setValue] = createSignal('a');
        setValue('b');
        expect(value()).toBe('b');
    });

    it('applies a functional updater with the previous value, chaining correctly', () =>
    {
        const [count, setCount] = createSignal(1);
        setCount((prev) => prev + 4);
        setCount((prev) => prev * 3);
        expect(count()).toBe(15);
    });

    it('supports undefined and null as first-class values', () =>
    {
        const [maybe, setMaybe] = createSignal<number | null | undefined>(undefined);
        expect(maybe()).toBeUndefined();
        setMaybe(null);
        expect(maybe()).toBeNull();
        setMaybe(7);
        expect(maybe()).toBe(7);
    });

    it('accepts an optional debug name without altering behavior', () =>
    {
        const [value, setValue] = createSignal(0, { name: 'counter' });
        setValue(9);
        expect(value()).toBe(9);
    });
});

describe('createSignal - change detection (equals)', () =>
{
    it('uses Object.is by default: writing the same primitive does not notify', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(5);
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            expect(runs).toBe(1);
            setN(5);
            expect(runs).toBe(1);
            setN(6);
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('treats a new object reference as a change under Object.is', () =>
    {
        createRoot((dispose) =>
        {
            const initial = { v: 1 };
            const [obj, setObj] = createSignal(initial);
            let runs = 0;
            createEffect(() =>
            {
                obj();
                runs++;
            });
            setObj(initial);
            expect(runs).toBe(1);
            setObj({ v: 1 });
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('honors a custom equals to widen "unchanged"', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(1.2, { equals: (a, b) => Math.floor(a) === Math.floor(b) });
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            setN(1.9);
            expect(runs).toBe(1);
            setN(2.1);
            expect(runs).toBe(2);
            dispose();
        });
    });

    it('an always-equal comparator suppresses every notification', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0, { equals: () => true });
            let runs = 0;
            createEffect(() =>
            {
                n();
                runs++;
            });
            setN(1);
            setN(2);
            expect(runs).toBe(1);
            expect(n()).toBe(0);
            dispose();
        });
    });
});

describe('subscriberCount', () =>
{
    it('reports zero for a signal with no live readers', () =>
    {
        const [n] = createSignal(0);
        expect(subscriberCount(n)).toBe(0);
    });

    it('reading outside a tracking scope does not create a subscription', () =>
    {
        const [n] = createSignal(0);
        n();
        n();
        expect(subscriberCount(n)).toBe(0);
    });

    it('counts each distinct effect subscriber and releases them on dispose', () =>
    {
        const [n, setN] = createSignal(0);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            createEffect(() =>
            {
                n();
            });
            createEffect(() =>
            {
                n();
            });
        });
        expect(subscriberCount(n)).toBe(2);
        dispose();
        setN(1);
        expect(subscriberCount(n)).toBe(0);
    });

    it('counts a memo as a subscriber from its eager first compute, released on dispose', () =>
    {
        const [n, setN] = createSignal(1);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            const doubled = createMemo(() => n() * 2);
            // createMemo eagerly computes once on creation, subscribing to n immediately.
            expect(subscriberCount(n)).toBe(1);
            expect(doubled()).toBe(2);
            expect(subscriberCount(n)).toBe(1);
        });
        dispose();
        setN(2);
        expect(subscriberCount(n)).toBe(0);
    });
});

describe('createSignal - isolation', () =>
{
    it('independent signals never cross-trigger', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(0);
            const [b, setB] = createSignal(0);
            let aRuns = 0;
            let bRuns = 0;
            createEffect(() =>
            {
                a();
                aRuns++;
            });
            createEffect(() =>
            {
                b();
                bRuns++;
            });
            setA(1);
            expect(aRuns).toBe(2);
            expect(bRuns).toBe(1);
            setB(1);
            expect(aRuns).toBe(2);
            expect(bRuns).toBe(2);
            dispose();
        });
    });
});
