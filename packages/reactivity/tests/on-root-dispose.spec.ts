// @vitest-environment node
//
// Full behavioral coverage for onRootDispose (on-root-dispose.ts): a scope-lifetime
// teardown that fires once on root disposal and, crucially, NOT on effect re-runs -
// the distinguishing contrast with onCleanup.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createRoot,
    onRootDispose
} from '@azerothjs/reactivity';

describe('onRootDispose', () =>
{
    it('runs once when the enclosing root is disposed', () =>
    {
        let disposed = 0;
        const dispose = createRoot((d) =>
        {
            onRootDispose(() =>
            {
                disposed++;
            });
            return d;
        });
        expect(disposed).toBe(0);
        dispose();
        expect(disposed).toBe(1);
    });

    it('does NOT fire on effect re-runs (unlike onCleanup)', () =>
    {
        const rootDisposals: number[] = [];
        const cleanups: number[] = [];
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            const [n, setN] = createSignal(0);
            onRootDispose(() => rootDisposals.push(1));
            createEffect(() =>
            {
                const value = n();
                // onCleanup fires every re-run; onRootDispose must not.
                if (value > 0)
                {
                    cleanups.push(value);
                }
            });
            setN(1);
            setN(2);
        });
        // Three effect runs happened, but the root is still alive.
        expect(rootDisposals).toEqual([]);
        dispose();
        expect(rootDisposals).toEqual([1]);
    });

    it('runs every registered callback in reverse (LIFO) order on disposal', () =>
    {
        // Disposers run last-registered-first, the conventional teardown order so a
        // later resource is released before the earlier one it may depend on.
        const order: string[] = [];
        const dispose = createRoot((d) =>
        {
            onRootDispose(() => order.push('a'));
            onRootDispose(() => order.push('b'));
            onRootDispose(() => order.push('c'));
            return d;
        });
        dispose();
        expect(order).toEqual(['c', 'b', 'a']);
    });

    it('fires only once even if dispose is called repeatedly', () =>
    {
        let count = 0;
        const dispose = createRoot((d) =>
        {
            onRootDispose(() =>
            {
                count++;
            });
            return d;
        });
        dispose();
        dispose();
        expect(count).toBe(1);
    });
});
