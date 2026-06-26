// @vitest-environment node
//
// Full behavioral coverage for createSelector (create-selector.ts): an O(1) reactive
// predicate where only the previously- and newly-selected keys' readers re-run.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createSelector,
    createEffect,
    createRoot
} from '@azerothjs/reactivity';

describe('createSelector', () =>
{
    it('only re-runs the previously- and newly-selected key effects on a selection change', () =>
    {
        createRoot((dispose) =>
        {
            const [selected, setSelected] = createSignal(1);
            const isSelected = createSelector(selected);
            const runs: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
            const state: Record<number, boolean> = { 1: false, 2: false, 3: false };
            for (const id of [1, 2, 3])
            {
                createEffect(() =>
                {
                    state[id] = isSelected(id);
                    runs[id]++;
                });
            }
            expect(state).toEqual({ 1: true, 2: false, 3: false });
            expect(runs).toEqual({ 1: 1, 2: 1, 3: 1 });

            setSelected(2);
            expect(state).toEqual({ 1: false, 2: true, 3: false });
            // Key 3 is untouched: O(1) targeting, not a full re-scan.
            expect(runs).toEqual({ 1: 2, 2: 2, 3: 1 });
            dispose();
        });
    });

    it('reading the predicate outside an effect yields a non-reactive one-shot value', () =>
    {
        createRoot((dispose) =>
        {
            const [selected, setSelected] = createSignal('a');
            const isSelected = createSelector(selected);
            expect(isSelected('a')).toBe(true);
            expect(isSelected('b')).toBe(false);
            setSelected('b');
            expect(isSelected('a')).toBe(false);
            expect(isSelected('b')).toBe(true);
            dispose();
        });
    });

    it('honors a custom equality to suppress no-op source changes', () =>
    {
        createRoot((dispose) =>
        {
            // Query key must be reference-stable (the producer map is reference-keyed);
            // the custom equals governs whether a source change counts as a flip.
            const a = { id: 1 };
            const [selected, setSelected] = createSignal(a);
            const isSelected = createSelector(selected, { equals: (x, y) => x.id === y.id });
            let runs = 0;
            let current = false;
            createEffect(() =>
            {
                current = isSelected(a);
                runs++;
            });
            expect(current).toBe(true);
            expect(runs).toBe(1);

            setSelected({ id: 1 }); // same id by custom equality -> no flip, no re-run
            expect(runs).toBe(1);
            expect(current).toBe(true);

            setSelected({ id: 2 }); // different id -> `a` deselects
            expect(runs).toBe(2);
            expect(current).toBe(false);
            dispose();
        });
    });
});
