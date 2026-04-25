import { describe, it, expect, vi } from 'vitest';
import { createSignal, createRoot, h, Show, Switch, Match, Dynamic, For, render } from '@azerothjs/core';

describe('Effect leak regression', () =>
{
    it('Show: disposes inner effects when branch swaps', () =>
    {
        const [show, setShow] = createSignal(true);
        const [count, setCount] = createSignal(0);
        const seen: number[] = [];

        const el = Show({ when: show }, () => h('p', {}, () =>
        {
            seen.push(count());
            return String(count());
        }));

        document.body.appendChild(el);

        expect(seen).toEqual([0]);

        // Hide — inner effect should unsubscribe.
        setShow(false);

        // Mutating count must NOT add to seen anymore.
        setCount(1);
        setCount(2);
        expect(seen).toEqual([0]);

        document.body.removeChild(el);
    });

    it('Show: disposes inner effects when parent root disposes', () =>
    {
        const [count, setCount] = createSignal(0);
        const seen: number[] = [];

        const dispose = createRoot((d) =>
        {
            Show({ when: () => true }, () => h('p', {}, () =>
            {
                seen.push(count());
                return String(count());
            }));
            return d;
        });

        expect(seen).toEqual([0]);

        dispose();

        setCount(99);
        expect(seen).toEqual([0]);
    });

    it('Switch: disposes losing branch effects on case change', () =>
    {
        const [which, setWhich] = createSignal<'a' | 'b'>('a');
        const [count, setCount] = createSignal(0);
        const aSeen: number[] = [];
        const bSeen: number[] = [];

        Switch(
            Match({ when: () => which() === 'a' }, () => h('p', {}, () =>
            {
                aSeen.push(count());
                return String(count());
            })),
            Match({ when: () => which() === 'b' }, () => h('p', {}, () =>
            {
                bSeen.push(count());
                return String(count());
            }))
        );

        expect(aSeen).toEqual([0]);
        expect(bSeen).toEqual([]);

        setWhich('b');
        expect(bSeen).toEqual([0]);

        // 'a' branch should be torn down — count change must NOT
        // add to aSeen anymore.
        setCount(5);
        expect(aSeen).toEqual([0]);
        expect(bSeen).toEqual([0, 5]);
    });

    it('For: disposes per-item effects when item is removed', () =>
    {
        const [items, setItems] = createSignal([1, 2, 3]);
        const [tick, setTick] = createSignal(0);
        const itemRuns = new Map<number, number>();

        For(
            { each: items, key: (n) => n },
            (n) => h('span', {}, () =>
            {
                itemRuns.set(n, (itemRuns.get(n) ?? 0) + 1);
                return `${ n }:${ tick() }`;
            })
        );

        expect(itemRuns.get(1)).toBe(1);
        expect(itemRuns.get(2)).toBe(1);
        expect(itemRuns.get(3)).toBe(1);

        // Remove item 2.
        setItems([1, 3]);

        const beforeTick = itemRuns.get(2);

        // Item 2's effect must be disposed — tick changes shouldn't
        // re-run it.
        setTick(1);
        expect(itemRuns.get(2)).toBe(beforeTick);

        // Surviving items DO re-run on the tick change.
        expect(itemRuns.get(1)).toBe(2);
        expect(itemRuns.get(3)).toBe(2);
    });

    it('Dynamic: prop signal changes do NOT rebuild the component', () =>
    {
        const setupCount = vi.fn();
        const Component = (p: Record<string, unknown>): HTMLElement =>
        {
            setupCount();
            return h('p', {}, String(p.label));
        };

        const [view, setView] = createSignal<((p: Record<string, unknown>) => HTMLElement) | null>(Component);
        const [label, setLabel] = createSignal('first');

        Dynamic({
            component: view,
            props: () => ({ label: label() })
        });

        expect(setupCount).toHaveBeenCalledTimes(1);

        // A label change must NOT re-run the component setup.
        setLabel('second');
        expect(setupCount).toHaveBeenCalledTimes(1);

        // But changing the COMPONENT does.
        const Other = (p: Record<string, unknown>): HTMLElement =>
        {
            setupCount();
            return h('p', {}, String(p.label));
        };
        setView(() => Other);
        expect(setupCount).toHaveBeenCalledTimes(2);
    });

    it('render: disposes prior tree on remount', () =>
    {
        const container = document.createElement('div');
        const [count, setCount] = createSignal(0);
        const seen: number[] = [];

        render(() => h('p', {}, () =>
        {
            seen.push(count());
            return String(count());
        }), container);

        expect(seen).toEqual([0]);

        // Remount — old effect must be disposed.
        render(() => h('p', {}, 'static'), container);

        setCount(1);
        expect(seen).toEqual([0]);
    });

    it('h(): reactive child swap disposes old element effects', () =>
    {
        const [showA, setShowA] = createSignal(true);
        const [count, setCount] = createSignal(0);
        const aSeen: number[] = [];

        h('div', {}, () => showA()
            ? h('span', {}, () =>
            {
                aSeen.push(count());
                return String(count());
            })
            : h('span', {}, 'B'));

        expect(aSeen).toEqual([0]);

        setShowA(false);

        setCount(1);
        // The 'A' branch's reactive text effect must be torn down.
        expect(aSeen).toEqual([0]);
    });
});
