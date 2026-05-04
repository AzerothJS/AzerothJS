import { describe, it, expect, vi } from 'vitest';
import {
    createRoot,
    createSignal,
    createMemo,
    createEffect,
    createStore
} from '@azerothjs/core';

describe('createStore', () =>
{
    it('returns a function', () =>
    {
        const useEmpty = createStore(() => ({}));
        expect(typeof useEmpty).toBe('function');
    });

    it('invokes the factory exactly once on first use', () =>
    {
        const factory = vi.fn(() => ({ value: 42 }));
        const useStore = createStore(factory);

        // No call yet — factory must not have run.
        expect(factory).not.toHaveBeenCalled();

        useStore();
        expect(factory).toHaveBeenCalledOnce();

        // Subsequent calls must NOT re-invoke.
        useStore();
        useStore();
        useStore();
        expect(factory).toHaveBeenCalledOnce();
    });

    it('returns the same instance reference on every call', () =>
    {
        const useStore = createStore(() => ({ marker: Symbol('once') }));

        const a = useStore();
        const b = useStore();
        const c = useStore();

        // Reference identity — true cross-component shared state.
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('exposes reactive signals — external effects re-run on change', () =>
    {
        const useCounter = createStore(() =>
        {
            const [count, setCount] = createSignal(0);
            return {
                count,
                set: (n: number) => setCount(n)
            };
        });

        const counter = useCounter();
        const observed: number[] = [];

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                observed.push(counter.count());
            });

            // Initial read.
            expect(observed).toEqual([0]);

            counter.set(1);
            counter.set(2);
            counter.set(3);

            expect(observed).toEqual([0, 1, 2, 3]);

            dispose();
        });
    });

    it('exposes memoized values that recompute when their deps change', () =>
    {
        const useNumbers = createStore(() =>
        {
            const [n, setN] = createSignal(2);
            const doubled = createMemo(() => n() * 2);
            const squared = createMemo(() => n() * n());

            return { n, doubled, squared, set: setN };
        });

        const store = useNumbers();

        expect(store.doubled()).toBe(4);
        expect(store.squared()).toBe(4);

        store.set(5);
        expect(store.doubled()).toBe(10);
        expect(store.squared()).toBe(25);
    });

    it('lets methods mutate state and notify subscribers', () =>
    {
        const useTodo = createStore(() =>
        {
            const [items, setItems] = createSignal<string[]>([]);
            return {
                items,
                add: (label: string) => setItems(prev => [...prev, label]),
                clear: () => setItems([])
            };
        });

        const todo = useTodo();
        const observed: string[][] = [];

        createRoot((dispose) =>
        {
            createEffect(() =>
            {
                observed.push(todo.items());
            });

            todo.add('write tests');
            todo.add('ship store');
            todo.clear();

            expect(observed).toEqual([
                [],
                ['write tests'],
                ['write tests', 'ship store'],
                []
            ]);

            dispose();
        });
    });

    it('keeps internal effects alive across consumer mounts and unmounts', () =>
    {
        // The factory creates a background effect that mirrors
        // the signal value into a side-channel array. Because the
        // effect is owned by the store's internal createRoot — not
        // any consumer's — it must keep running even after every
        // consumer's createRoot has disposed.
        const sideChannel: number[] = [];

        const useTracker = createStore(() =>
        {
            const [value, setValue] = createSignal(0);

            createEffect(() =>
            {
                sideChannel.push(value());
            });

            return { value, set: setValue };
        });

        const tracker = useTracker();
        // Initial run records the starting value.
        expect(sideChannel).toEqual([0]);

        // Consumer A mounts, reads, unmounts.
        createRoot((disposeA) =>
        {
            createEffect(() =>
            {
                tracker.value();
            });
            disposeA();
        });

        // Consumer B mounts, reads, unmounts.
        createRoot((disposeB) =>
        {
            createEffect(() =>
            {
                tracker.value();
            });
            disposeB();
        });

        // The store's own background effect should still be live —
        // mutating now must still record into the side channel.
        tracker.set(1);
        tracker.set(2);
        expect(sideChannel).toEqual([0, 1, 2]);
    });
});
