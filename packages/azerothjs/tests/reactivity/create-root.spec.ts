// @vitest-environment node
//
// Full behavioral coverage for createRoot (create-root.ts): return-value pass-through,
// the dispose handle, cascading teardown of owned effects/memos, independent nesting,
// and idempotent disposal.
import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, createMemo, createRoot, onCleanup, onRootDispose, getOwner, runWithOwner } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';

describe('createRoot', () =>
{
    it('returns the value produced by its callback', () =>
    {
        const result = createRoot((dispose) =>
        {
            dispose();
            return 123;
        });
        expect(result).toBe(123);
    });

    it('provides a dispose handle that tears down every owned effect and memo', () =>
    {
        const [n, setN] = createSignal(0);
        let dispose!: () => void;
        let effectRuns = 0;
        createRoot((d) =>
        {
            dispose = d;
            createEffect(() =>
            {
                n();
                effectRuns++;
            });
            createMemo(() => n() + 1);
        });
        expect(subscriberCount(n)).toBe(2);
        expect(effectRuns).toBe(1);

        dispose();
        setN(1);
        expect(subscriberCount(n)).toBe(0);
        expect(effectRuns).toBe(1);
    });

    it('runs onCleanup callbacks of owned effects on disposal', () =>
    {
        const cleaned: string[] = [];
        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                onCleanup(() => cleaned.push('effect-cleanup'));
            });
            return d;
        });
        expect(cleaned).toEqual([]);
        dispose();
        expect(cleaned).toEqual(['effect-cleanup']);
    });

    it('disposes nested roots independently of the outer root', () =>
    {
        const [n] = createSignal(0);
        let disposeOuter!: () => void;
        let disposeInner!: () => void;
        createRoot((outer) =>
        {
            disposeOuter = outer;
            createEffect(() =>
            {
                n();
            });
            createRoot((inner) =>
            {
                disposeInner = inner;
                createEffect(() =>
                {
                    n();
                });
            });
        });

        expect(subscriberCount(n)).toBe(2);
        disposeInner();
        expect(subscriberCount(n)).toBe(1); // outer effect survives
        disposeOuter();
        expect(subscriberCount(n)).toBe(0);
    });

    it('a nested root is an independent scope - the outer dispose does NOT cascade to it', () =>
    {
        const [n] = createSignal(0);
        let disposeOuter!: () => void;
        let disposeInner!: () => void;
        createRoot((outer) =>
        {
            disposeOuter = outer;
            createRoot((inner) =>
            {
                disposeInner = inner;
                createEffect(() =>
                {
                    n();
                });
            });
        });
        expect(subscriberCount(n)).toBe(1);
        // createRoot deliberately detaches ownership: the inner scope survives the
        // outer's disposal and must be disposed on its own.
        disposeOuter();
        expect(subscriberCount(n)).toBe(1);
        disposeInner();
        expect(subscriberCount(n)).toBe(0);
    });

    it('a child root can be tied to its parent by registering its dispose with onRootDispose', () =>
    {
        const [n] = createSignal(0);
        let disposeOuter!: () => void;
        createRoot((outer) =>
        {
            disposeOuter = outer;
            const disposeChild = createRoot((inner) =>
            {
                createEffect(() =>
                {
                    n();
                });
                return inner;
            });
            onRootDispose(disposeChild);
        });
        expect(subscriberCount(n)).toBe(1);
        disposeOuter(); // now cascades, because the child's dispose was wired in
        expect(subscriberCount(n)).toBe(0);
    });

    it('dispose is idempotent', () =>
    {
        const [n] = createSignal(0);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            createEffect(() =>
            {
                n();
            });
        });
        expect(() =>
        {
            dispose();
            dispose();
        }).not.toThrow();
        expect(subscriberCount(n)).toBe(0);
    });
});

describe('createRoot - disposal robustness', () =>
{
    it('an effect created under an ALREADY-disposed owner does not leak (runWithOwner after teardown)', () =>
    {
        const [n, setN] = createSignal(0);
        let captured!: ReturnType<typeof getOwner>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            captured = getOwner();
        });
        // The owner tore down (as if a component unmounted during an await).
        dispose();
        expect(captured).not.toBeNull();

        let runs = 0;
        runWithOwner(captured, () =>
        {
            createEffect(() =>
            {
                n();
                runs++;
            });
        });
        // The effect ran its first pass once, then was immediately reaped - not left
        // subscribed to `n`, which would re-run it forever.
        expect(subscriberCount(n)).toBe(0);
        setN(1);
        expect(runs).toBe(1); // never re-ran: no leak
    });

    it('a disposer that spawns reactive work during teardown does not leak it', () =>
    {
        const [n, setN] = createSignal(0);
        let runs = 0;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            onRootDispose(() =>
            {
                // Reactive work spawned DURING teardown: the owner is dead, so this must be
                // reaped at once, not registered into the array being drained (dropped) nor
                // left subscribed (leaked).
                createEffect(() =>
                {
                    n();
                    runs++;
                });
            });
        });
        dispose();
        expect(subscriberCount(n)).toBe(0);
        setN(1);
        expect(runs).toBe(1); // ran once during teardown, never again
    });

    it('a throwing disposer neither strands siblings nor drops disposal-time registrations', () =>
    {
        const [n] = createSignal(0);
        const order: string[] = [];
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            onRootDispose(() => order.push('first-registered')); // runs LAST (LIFO)
            onRootDispose(() =>
            {
                throw new Error('boom');
            });
            onRootDispose(() => order.push('third-registered')); // runs FIRST
            createEffect(() =>
            {
                n();
            });
        });
        // The throwing disposer surfaces its error, but only AFTER every sibling ran and the
        // effect was torn down.
        expect(() => dispose()).toThrow('boom');
        expect(order).toEqual(['third-registered', 'first-registered']);
        expect(subscriberCount(n)).toBe(0);
    });
});
