// Property-style test for the cursor-based dependency tracking in graph.ts.
// The cursor design's subtle cases are dependency-ORDER changes between runs
// (a branch flips and the same signals are read in a different order, or a
// different subset entirely). This drives an effect through seeded-random
// read plans and asserts, after every run, that each signal's subscriber
// list contains the effect exactly when the last run read it - no stale
// links, no missed links, no duplicates.

import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, createMemo, subscriberCount, type Signal } from '@azerothjs/reactivity';

/** Mulberry32 - deterministic runs or this test is useless on failure. */
function createRng(seed: number): () => number
{
    let state = seed >>> 0;
    return function next(): number
    {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A random read plan: subset of signal indices, shuffled, with duplicates. */
function randomPlan(rng: () => number, signalCount: number): number[]
{
    const plan: number[] = [];
    for (let i = 0; i < signalCount; i++)
    {
        if (rng() < 0.5)
        {
            plan.push(i);
        }
    }
    // Shuffle so the read ORDER differs run to run, not just the subset.
    for (let i = plan.length - 1; i > 0; i--)
    {
        const j = Math.floor(rng() * (i + 1));
        const tmp = plan[i];
        plan[i] = plan[j];
        plan[j] = tmp;
    }
    // Sometimes read one signal twice in a run - must still link once.
    if (plan.length > 0 && rng() < 0.3)
    {
        plan.push(plan[Math.floor(rng() * plan.length)]);
    }
    return plan;
}

const SIGNAL_COUNT = 8;
const CYCLES = 200;
const SEED = 0x5eed;

describe('dependency tracking under randomized read plans', () =>
{
    it('an effect is subscribed to exactly the signals its last run read', () =>
    {
        const rng = createRng(SEED);
        const signals: Signal<number>[] = [];
        for (let i = 0; i < SIGNAL_COUNT; i++)
        {
            signals.push(createSignal(i));
        }

        let plan: number[] = [0, 1, 2];
        let runs = 0;
        const [version, setVersion] = createSignal(0);

        const dispose = createEffect(() =>
        {
            version();
            for (const idx of plan)
            {
                signals[idx][0]();
            }
            runs++;
        });

        for (let cycle = 0; cycle < CYCLES; cycle++)
        {
            plan = randomPlan(rng, SIGNAL_COUNT);
            const runsBefore = runs;
            setVersion(v => v + 1);
            expect(runs).toBe(runsBefore + 1);

            const inPlan = new Set(plan);
            for (let i = 0; i < SIGNAL_COUNT; i++)
            {
                const expected = inPlan.has(i) ? 1 : 0;
                if (subscriberCount(signals[i][0]) !== expected)
                {
                    throw new Error(
                        `cycle ${ cycle }: signal ${ i } has ${ subscriberCount(signals[i][0]) } subscribers, ` +
                        `expected ${ expected } (plan: [${ plan.join(', ') }])`
                    );
                }
            }

            // Behavioral check: a write to a read signal re-runs the effect,
            // a write to a dropped one does not.
            const read = plan.length > 0 ? plan[Math.floor(rng() * plan.length)] : null;
            const dropped = [...Array(SIGNAL_COUNT).keys()].find(i => !inPlan.has(i)) ?? null;

            if (dropped !== null)
            {
                const before = runs;
                signals[dropped][1](v => v + 1);
                expect(runs).toBe(before);
            }
            if (read !== null)
            {
                const before = runs;
                signals[read][1](v => v + 1);
                expect(runs).toBe(before + 1);
            }
        }

        dispose();
        for (let i = 0; i < SIGNAL_COUNT; i++)
        {
            expect(subscriberCount(signals[i][0])).toBe(0);
        }
        expect(subscriberCount(version)).toBe(0);
    });

    it('a memo relinks correctly when its compute branches', () =>
    {
        const rng = createRng(SEED ^ 0xffff);
        const signals: Signal<number>[] = [];
        for (let i = 0; i < SIGNAL_COUNT; i++)
        {
            signals.push(createSignal(i));
        }

        let plan: number[] = [0];
        const [version, setVersion] = createSignal(0);

        const sum = createMemo(() =>
        {
            let total = version() * 1000;
            for (const idx of plan)
            {
                total += signals[idx][0]();
            }
            return total;
        });

        let observed = 0;
        const dispose = createEffect(() =>
        {
            observed = sum();
        });

        for (let cycle = 0; cycle < CYCLES; cycle++)
        {
            plan = randomPlan(rng, SIGNAL_COUNT);
            setVersion(v => v + 1);

            const inPlan = new Set(plan);
            for (let i = 0; i < SIGNAL_COUNT; i++)
            {
                expect(subscriberCount(signals[i][0])).toBe(inPlan.has(i) ? 1 : 0);
            }

            // The memo's value must reflect the plan it just computed.
            let expected = (cycle + 1) * 1000;
            for (const idx of plan)
            {
                expected += untrackedRead(signals[idx][0]);
            }
            expect(observed).toBe(expected);
        }

        dispose();
        // The memo stays subscribed (it is not owned by the effect), but the
        // effect must have released the memo itself.
        expect(subscriberCount(sum)).toBe(0);
    });
});

/** Plain read outside any effect - no subscription side effect. */
function untrackedRead(getter: () => number): number
{
    return getter();
}
