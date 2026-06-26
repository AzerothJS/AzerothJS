// @vitest-environment node
//
// Full behavioral coverage for on (on.ts): explicit dependency watching, previous
// values, incidental untracked reads, the defer option, and disposal.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createRoot,
    on
} from '@azerothjs/reactivity';

describe('on', () =>
{
    it('watches only the listed deps and ignores other sources read inside fn', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(1);
            const [incidental, setIncidental] = createSignal(100);
            const seen: number[] = [];
            on([a], ([cur]) =>
            {
                // Reading `incidental` here must NOT subscribe.
                void incidental();
                seen.push(cur);
            });
            setIncidental(200);
            expect(seen).toEqual([1]);
            setA(2);
            expect(seen).toEqual([1, 2]);
            dispose();
        });
    });

    it('passes current and previous value tuples', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(10);
            const transitions: Array<[number, number | undefined]> = [];
            on([a], ([cur], [prev]) => transitions.push([cur, prev]));
            setA(20);
            setA(30);
            expect(transitions).toEqual([
                [10, undefined],
                [20, 10],
                [30, 20]
            ]);
            dispose();
        });
    });

    it('watches multiple deps and fires on any of them', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(1);
            const [b, setB] = createSignal(2);
            const snapshots: Array<[number, number]> = [];
            on([a, b], ([av, bv]) => snapshots.push([av, bv]));
            setA(10);
            setB(20);
            expect(snapshots).toEqual([
                [1, 2],
                [10, 2],
                [10, 20]
            ]);
            dispose();
        });
    });

    it('skips the initial invocation when defer is set', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal('start');
            const runs: string[] = [];
            on([a], ([cur]) => runs.push(cur), { defer: true });
            expect(runs).toEqual([]);
            setA('next');
            expect(runs).toEqual(['next']);
            dispose();
        });
    });

    it('returns a dispose function that stops watching', () =>
    {
        createRoot(() =>
        {
            const [a, setA] = createSignal(0);
            let runs = 0;
            const dispose = on([a], () =>
            {
                runs++;
            });
            setA(1);
            expect(runs).toBe(2);
            dispose();
            setA(2);
            expect(runs).toBe(2);
        });
    });
});
