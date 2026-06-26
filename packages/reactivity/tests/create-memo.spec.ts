// @vitest-environment node
//
// Full behavioral coverage for createMemo (create-memo.ts): eager first compute,
// cached reads, lazy read-driven recompute, version-gated propagation, custom
// equality, transitive chains, and disposal.
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal,
    createMemo,
    createEffect,
    createRoot,
    subscriberCount
} from '@azerothjs/reactivity';

describe('createMemo — compute lifecycle', () =>
{
    it('computes eagerly exactly once on creation', () =>
    {
        createRoot((dispose) =>
        {
            const compute = vi.fn(() => 7);
            const memo = createMemo(compute);
            expect(compute).toHaveBeenCalledTimes(1);
            expect(memo()).toBe(7);
            expect(memo()).toBe(7);
            expect(compute).toHaveBeenCalledTimes(1);
            dispose();
        });
    });

    it('recomputes lazily: a dependency change marks dirty but defers work until read', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(2);
            const compute = vi.fn(() => n() * 10);
            const memo = createMemo(compute);
            expect(compute).toHaveBeenCalledTimes(1);
            expect(memo()).toBe(20);

            setN(3);
            // No live downstream reader -> nothing pulls the memo -> no recompute yet.
            expect(compute).toHaveBeenCalledTimes(1);
            expect(memo()).toBe(30);
            expect(compute).toHaveBeenCalledTimes(2);
            dispose();
        });
    });

    it('routes its dependency subscription through the owning root', () =>
    {
        const [n, setN] = createSignal(1);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            createMemo(() => n() + 1);
            expect(subscriberCount(n)).toBe(1);
        });
        dispose();
        setN(2);
        expect(subscriberCount(n)).toBe(0);
    });
});

describe('createMemo — propagation and equality', () =>
{
    it('propagates to downstream readers only when its value actually changes', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(4);
            const isEven = createMemo(() => n() % 2 === 0);
            let downstream = 0;
            createEffect(() =>
            {
                isEven();
                downstream++;
            });
            expect(downstream).toBe(1);

            setN(6); // still even -> memo value unchanged -> no downstream run
            expect(downstream).toBe(1);

            setN(7); // now odd -> memo flips -> downstream runs once
            expect(downstream).toBe(2);
            dispose();
        });
    });

    it('honors a custom equals to suppress downstream churn', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(1);
            const bucketed = createMemo(() => n(), { equals: (a, b) => Math.floor(a / 10) === Math.floor(b / 10) });
            let downstream = 0;
            createEffect(() =>
            {
                bucketed();
                downstream++;
            });
            expect(downstream).toBe(1);
            setN(5); // same bucket (0)
            expect(downstream).toBe(1);
            setN(15); // new bucket (1)
            expect(downstream).toBe(2);
            dispose();
        });
    });
});

describe('createMemo — chains', () =>
{
    it('invalidates transitively through a chain of memos', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(1);
            const a = createMemo(() => n() + 1);
            const b = createMemo(() => a() * 2);
            const c = createMemo(() => b() + a());
            expect(c()).toBe(6); // a=2, b=4, c=6
            setN(3);
            expect(c()).toBe(12); // a=4, b=8, c=12
            dispose();
        });
    });

    it('recomputes a deep chain at most once per pull when an upstream changes', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            const mid = vi.fn(() => n() + 1);
            const a = createMemo(mid);
            const top = createMemo(() => a() + a()); // reads a twice
            expect(top()).toBe(2);
            expect(mid).toHaveBeenCalledTimes(1);
            setN(10);
            expect(top()).toBe(22);
            // a recomputed once despite being read twice by `top`.
            expect(mid).toHaveBeenCalledTimes(2);
            dispose();
        });
    });
});
