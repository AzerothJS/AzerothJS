// @vitest-environment node
//
// Full behavioral coverage for createEffect (create-effect.ts): eager run, dynamic
// dependency tracking, the return-value cleanup contract, onCleanup, manual dispose,
// and ownership by the enclosing root.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    onCleanup,
    subscriberCount
} from '@azerothjs/reactivity';

describe('createEffect — execution', () =>
{
    it('runs immediately and re-runs on every tracked change', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal('x');
            const seen: string[] = [];
            createEffect(() =>
            {
                seen.push(a());
            });
            setA('y');
            setA('z');
            expect(seen).toEqual(['x', 'y', 'z']);
            dispose();
        });
    });

    it('tracks dependencies dynamically — an untaken branch is not subscribed', () =>
    {
        createRoot((dispose) =>
        {
            const [flag, setFlag] = createSignal(true);
            const [a, setA] = createSignal('a');
            const [b, setB] = createSignal('b');
            let runs = 0;
            createEffect(() =>
            {
                runs++;
                if (flag())
                {
                    a();
                }
                else
                {
                    b();
                }
            });
            expect(runs).toBe(1);

            setB('b2'); // b not read while flag true
            expect(runs).toBe(1);
            setA('a2'); // a is read
            expect(runs).toBe(2);

            setFlag(false); // switch tracked branch
            expect(runs).toBe(3);
            setA('a3'); // a no longer read
            expect(runs).toBe(3);
            setB('b3'); // b now read
            expect(runs).toBe(4);
            dispose();
        });
    });

    it('reads memos and re-runs when the memo value changes', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(1);
            const doubled = createMemo(() => n() * 2);
            const seen: number[] = [];
            createEffect(() =>
            {
                seen.push(doubled());
            });
            setN(2);
            expect(seen).toEqual([2, 4]);
            dispose();
        });
    });
});

describe('createEffect — cleanup contract', () =>
{
    it('treats a returned function as cleanup: runs before each re-run and on dispose', () =>
    {
        const calls: string[] = [];
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            createEffect(() =>
            {
                const value = n();
                return () => calls.push(`cleanup-${ value }`);
            });
            setN(1);
            expect(calls).toEqual(['cleanup-0']);
            setN(2);
            expect(calls).toEqual(['cleanup-0', 'cleanup-1']);
            dispose();
            expect(calls).toEqual(['cleanup-0', 'cleanup-1', 'cleanup-2']);
        });
    });

    it('onCleanup matches the returned-cleanup timing and supports multiple registrations', () =>
    {
        const calls: string[] = [];
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            createEffect(() =>
            {
                const value = n();
                onCleanup(() => calls.push(`a-${ value }`));
                onCleanup(() => calls.push(`b-${ value }`));
            });
            setN(1);
            expect(calls).toEqual(['a-0', 'b-0']);
            dispose();
            expect(calls).toEqual(['a-0', 'b-0', 'a-1', 'b-1']);
        });
    });
});

describe('createEffect — disposal and ownership', () =>
{
    it('the returned dispose function stops further runs and unsubscribes', () =>
    {
        createRoot(() =>
        {
            const [n, setN] = createSignal(0);
            let runs = 0;
            const dispose = createEffect(() =>
            {
                n();
                runs++;
            });
            expect(subscriberCount(n)).toBe(1);
            setN(1);
            expect(runs).toBe(2);
            dispose();
            expect(subscriberCount(n)).toBe(0);
            setN(2);
            expect(runs).toBe(2);
        });
    });

    it('is disposed together with its owning root', () =>
    {
        const [n, setN] = createSignal(0);
        let runs = 0;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            createEffect(() =>
            {
                n();
                runs++;
            });
        });
        setN(1);
        expect(runs).toBe(2);
        dispose();
        setN(2);
        expect(runs).toBe(2);
        expect(subscriberCount(n)).toBe(0);
    });

    it('manual dispose is idempotent', () =>
    {
        createRoot(() =>
        {
            const [n] = createSignal(0);
            const dispose = createEffect(() =>
            {
                n();
            });
            expect(() =>
            {
                dispose();
                dispose();
            }).not.toThrow();
            expect(subscriberCount(n)).toBe(0);
        });
    });
});

describe('createEffect — auto-tracking only (no explicit deps/defer)', () =>
{
    it('subscribes to exactly the sources its body reads (deps are discovered by running)', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            const seen: number[] = [];
            createEffect(() =>
            {
                seen.push(n());
            });
            expect(seen).toEqual([0]);   // runs on mount
            setN(1);
            expect(seen).toEqual([0, 1]); // and re-runs when a read source changes
            expect(subscriberCount(n)).toBe(1);
            dispose();
        });
    });
});
