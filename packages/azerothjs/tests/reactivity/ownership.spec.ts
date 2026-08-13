// @vitest-environment node
//
// The ownership contract: every computation that can own work owns it in a scope of its own.
//
// Before this, only createRoot allocated an Owner. Effects and memos captured the AMBIENT owner and
// re-established that same owner around every run, which meant a computation created inside another
// computation belonged to the enclosing ROOT rather than to the run that made it - so it was never
// torn down. Each test here pins one consequence of that, and each was observed failing against the
// tree that had the old model.
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal,
    createEffect,
    createMemo,
    createRoot,
    onCleanup
} from 'azerothjs';

describe('a computation owns the work its run creates', () =>
{
    it('disposes a nested effect when the outer effect re-runs', () =>
    {
        // The signature of the old model was TRIANGULAR growth: every re-run left the previous
        // run's inner effect alive AND created another, so a write woke all of them. Counting the
        // inner runs per outer re-run is what distinguishes "disposed" from "accumulating" -
        // asserting only the final total would pass with any number of live effects.
        const [n, setN] = createSignal(0);
        let innerRuns = 0;
        const perOuterRun: number[] = [];

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                n();
                createEffect(() =>
                {
                    innerRuns++;
                    n();
                });
            });
            return d;
        });

        for (let i = 1; i <= 4; i += 1)
        {
            setN(i);
            perOuterRun.push(innerRuns);
        }
        dispose();

        // One inner effect alive at a time: each write runs the outer (making a fresh inner, +1)
        // and the one live inner (+1)... but the old inner is disposed first, so the total climbs
        // by exactly one per write. Old model produced [3, 6, 10, 15].
        expect(perOuterRun).toEqual([2, 3, 4, 5]);
    });

    it('disposes a nested memo when the outer effect re-runs', () =>
    {
        const [n, setN] = createSignal(0);
        let computes = 0;

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                n();
                const inner = createMemo(() =>
                {
                    computes++;
                    return n();
                });
                inner();
            });
            return d;
        });

        setN(1);
        setN(2);
        dispose();

        // One compute per outer run: 3 runs (initial + 2 writes). A memo that outlives its run
        // recomputes for every later write as well.
        expect(computes).toBe(3);
    });

    it('tears down a nested effect when the OWNING effect is disposed', () =>
    {
        const [n, setN] = createSignal(0);
        let innerRuns = 0;

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                createEffect(() =>
                {
                    innerRuns++;
                    n();
                });
            });
            return d;
        });

        const atDispose = innerRuns;
        dispose();
        setN(1);

        expect(innerRuns).toBe(atDispose);
    });
});

describe('cleanups run outside the tracking scope', () =>
{
    it('a signal read inside a cleanup subscribes nothing', () =>
    {
        // The old model drained the previous run's cleanups BEFORE installing the effect's own
        // subscriber, so the reads inside a cleanup landed on whichever computation happened to be
        // ambient. That only shows up when the re-run is triggered from INSIDE another tracked run
        // - which is what error-boundary.ts does - so the driver here writes during its own run.
        const [s, setS] = createSignal(0);
        const [unread, setUnread] = createSignal(0);
        const [go] = createSignal(0);
        let subjectRuns = 0;
        let driverRuns = 0;

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                s();
                subjectRuns++;
                onCleanup(() =>
                {
                    unread();
                });
            });
            createEffect(() =>
            {
                driverRuns++;
                go();
                setS((v) => v + 1);
            });
            return d;
        });

        const before = { subjectRuns, driverRuns };
        // Nothing legitimately reads `unread`. If a cleanup's read leaked into a subscription,
        // this write wakes a computation.
        setUnread(1);

        expect(subjectRuns).toBe(before.subjectRuns);
        expect(driverRuns).toBe(before.driverRuns);
        dispose();
    });

    it('a signal read inside a dispose-path cleanup subscribes nothing', () =>
    {
        const [unread, setUnread] = createSignal(0);
        const [go] = createSignal(0);
        let outerRuns = 0;

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                outerRuns++;
                go();
                // Disposing a root from inside a tracked run is the shape error-boundary.ts uses
                // when it tears a branch down; the cleanups must not subscribe THIS effect.
                const inner = createRoot((innerDispose) =>
                {
                    createEffect(() =>
                    {
                        onCleanup(() =>
                        {
                            unread();
                        });
                    });
                    return innerDispose;
                });
                inner();
            });
            return d;
        });

        const before = outerRuns;
        setUnread(1);

        expect(outerRuns).toBe(before);
        dispose();
    });
});

describe('onCleanup registers against the nearest scope', () =>
{
    it('fires when the enclosing root disposes - the pattern the README teaches', () =>
    {
        // packages/azerothjs/README.md documents onCleanup inside a createRoot body as "teardown
        // when the root disposes". Under the old model it registered nowhere and fired zero times.
        let ran = 0;

        const dispose = createRoot((d) =>
        {
            onCleanup(() =>
            {
                ran++;
            });
            return d;
        });

        expect(ran).toBe(0);
        dispose();
        expect(ran).toBe(1);
    });

    it('fires once per root disposal, not once per enclosing effect re-run', () =>
    {
        const [n, setN] = createSignal(0);
        let rootLevel = 0;

        const dispose = createRoot((d) =>
        {
            onCleanup(() =>
            {
                rootLevel++;
            });
            createEffect(() =>
            {
                n();
            });
            return d;
        });

        setN(1);
        setN(2);
        expect(rootLevel).toBe(0);

        dispose();
        expect(rootLevel).toBe(1);
    });

    it('still prefers the effect scope inside an effect run', () =>
    {
        // Unchanged behaviour, pinned so the owner fallback cannot swallow it: inside an effect,
        // onCleanup means "before my next run", not "when the root dies".
        const [n, setN] = createSignal(0);
        const log: string[] = [];

        const dispose = createRoot((d) =>
        {
            createEffect(() =>
            {
                const value = n();
                onCleanup(() => log.push(`cleanup-${ value }`));
            });
            return d;
        });

        setN(1);
        expect(log).toEqual(['cleanup-0']);
        dispose();
        expect(log).toEqual(['cleanup-0', 'cleanup-1']);
    });
});

// Context scoping lives with the compiler now, because a component boundary is EMITTED - see
// packages/compiler/tests/component-scope.spec.ts. The version of this that lived here drove plain
// JS functions, which the compiler never sees, so it could not have proven the contract either way.

describe('a computation with no owner is reported', () =>
{
    it('warns in development that it can never be disposed', () =>
    {
        // Silent leakage was the old behaviour: an effect created with no enclosing root ran, kept
        // running, and nothing could ever tear it down. The warning is the only signal a developer
        // can get, since the return value is the caller's only handle.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const [n, setN] = createSignal(0);
            createEffect(() =>
            {
                n();
            });
            setN(1);

            expect(warn).toHaveBeenCalled();
            expect(String(warn.mock.calls[0]?.[0] ?? '')).toMatch(/owner|dispose/i);
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('says nothing when an owner is present', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const dispose = createRoot((d) =>
            {
                createEffect(() => undefined);
                return d;
            });
            dispose();

            expect(warn).not.toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});
