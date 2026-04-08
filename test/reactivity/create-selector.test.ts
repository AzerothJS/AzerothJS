import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, createSelector } from '@azerothjs/core';

describe('createSelector', () =>
{
    it('should return true for the selected key', () =>
    {
        const [selected] = createSignal(2);
        const isSelected = createSelector(selected);

        expect(isSelected(1)).toBe(false);
        expect(isSelected(2)).toBe(true);
        expect(isSelected(3)).toBe(false);
    });

    it('should update when selection changes', () =>
    {
        const [selected, setSelected] = createSignal(1);
        const isSelected = createSelector(selected);

        expect(isSelected(1)).toBe(true);
        expect(isSelected(2)).toBe(false);

        setSelected(2);
        expect(isSelected(1)).toBe(false);
        expect(isSelected(2)).toBe(true);
    });

    it('should only notify affected effects on selection change', () =>
    {
        const [selected, setSelected] = createSignal<number>(1);
        const isSelected = createSelector(selected);

        let item1Runs = 0;
        let item2Runs = 0;
        let item3Runs = 0;

        createEffect(() =>
        {
            isSelected(1);
            item1Runs++;
        });

        createEffect(() =>
        {
            isSelected(2);
            item2Runs++;
        });

        createEffect(() =>
        {
            isSelected(3);
            item3Runs++;
        });

        // All ran once on creation
        expect(item1Runs).toBe(1);
        expect(item2Runs).toBe(1);
        expect(item3Runs).toBe(1);

        // Change selection from 1 → 2
        item1Runs = 0;
        item2Runs = 0;
        item3Runs = 0;
        setSelected(2);

        // Only item 1 (deselected) and item 2 (selected) should re-run
        expect(item1Runs).toBe(1);
        expect(item2Runs).toBe(1);
        expect(item3Runs).toBe(0);
    });

    it('should work with string keys', () =>
    {
        const [selected, setSelected] = createSignal('home');
        const isSelected = createSelector(selected);

        expect(isSelected('home')).toBe(true);
        expect(isSelected('about')).toBe(false);

        setSelected('about');
        expect(isSelected('home')).toBe(false);
        expect(isSelected('about')).toBe(true);
    });

    it('should support custom equality', () =>
    {
        const [selected, setSelected] = createSignal('HELLO');
        const isSelected = createSelector(selected, (a, b) =>
            a.toLowerCase() === b.toLowerCase()
        );

        expect(isSelected('hello')).toBe(true);
        expect(isSelected('HELLO')).toBe(true);
        expect(isSelected('world')).toBe(false);

        setSelected('world');
        expect(isSelected('hello')).toBe(false);
        expect(isSelected('WORLD')).toBe(true);
    });

    it('should handle selection changing multiple times', () =>
    {
        const [selected, setSelected] = createSignal(1);
        const isSelected = createSelector(selected);

        const log: string[] = [];

        createEffect(() =>
        {
            log.push(`item1:${ isSelected(1) }`);
        });

        createEffect(() =>
        {
            log.push(`item2:${ isSelected(2) }`);
        });

        expect(log).toEqual(['item1:true', 'item2:false']);

        log.length = 0;
        setSelected(2);
        // item1 becomes false, item2 becomes true
        expect(log).toContain('item1:false');
        expect(log).toContain('item2:true');

        log.length = 0;
        setSelected(1);
        // item1 becomes true, item2 becomes false
        expect(log).toContain('item1:true');
        expect(log).toContain('item2:false');
    });

    it('should clean up disposed subscribers', () =>
    {
        const [selected, setSelected] = createSignal(1);
        const isSelected = createSelector(selected);

        let runs = 0;
        const dispose = createEffect(() =>
        {
            isSelected(1);
            runs++;
        });

        expect(runs).toBe(1);

        dispose();

        runs = 0;
        setSelected(2);
        setSelected(1);
        // Disposed effect should not run
        expect(runs).toBe(0);
    });

    it('should handle selecting a key with no subscribers', () =>
    {
        const [selected, setSelected] = createSignal(1);
        const isSelected = createSelector(selected);

        // Only subscribe to key 1
        let runs = 0;
        createEffect(() =>
        {
            isSelected(1);
            runs++;
        });

        runs = 0;
        // Select key 99 — no subscribers for it, should not throw
        setSelected(99);
        // item1 was deselected, so its effect should re-run
        expect(runs).toBe(1);
    });
});
