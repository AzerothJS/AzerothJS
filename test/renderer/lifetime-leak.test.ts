// Lifetime audit regression tests. Unlike leak-regression.test.ts (which
// asserts disposed effects stop RUNNING), these assert the retention side:
// signal subscriber sets must return to their baseline size after mount/
// unmount cycles, so disposed subscribers are actually unlinked rather than
// just silenced. subscriberCount() is the internal probe for that.

import { describe, it, expect, vi } from 'vitest';
import { createSignal, createEffect, subscriberCount } from '@azerothjs/reactivity';
import { h, Show, Switch, Match, For, Portal, render, destroyPortal } from '@azerothjs/core';

describe('Subscriber lifetime', () =>
{
    it('render: repeated remounts return the signal to baseline', () =>
    {
        const container = document.createElement('div');
        const [count, setCount] = createSignal(0);

        expect(subscriberCount(count)).toBe(0);

        for (let cycle = 0; cycle < 25; cycle++)
        {
            render(() => h('p', {}, () => String(count())), container);
            expect(subscriberCount(count)).toBe(1);

            render(() => h('p', {}, 'static'), container);
            expect(subscriberCount(count)).toBe(0);
        }

        // A write with no subscribers must be a no-op, not a crash.
        setCount(1);
        expect(subscriberCount(count)).toBe(0);
    });

    it('Show: repeated toggles do not accumulate subscribers', () =>
    {
        const [show, setShow] = createSignal(false);
        const [count] = createSignal(0);

        Show({ when: show, children: () => h('p', {}, () => String(count())) });

        for (let cycle = 0; cycle < 25; cycle++)
        {
            setShow(true);
            expect(subscriberCount(count)).toBe(1);

            setShow(false);
            expect(subscriberCount(count)).toBe(0);
        }
    });

    it('For: removed rows release their subscriptions', () =>
    {
        const [items, setItems] = createSignal<number[]>([]);
        const [tick] = createSignal(0);

        For({
            each: items,
            key: (n) => n,
            children: (n) => h('span', {}, () => `${ n }:${ tick() }`)
        });

        for (let cycle = 0; cycle < 10; cycle++)
        {
            setItems([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            expect(subscriberCount(tick)).toBe(10);

            setItems([]);
            expect(subscriberCount(tick)).toBe(0);
        }
    });

    it('For: a displaced duplicate-key row is disposed, not leaked', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const [items, setItems] = createSignal<string[]>(['x', 'x']);
        const [tick] = createSignal(0);

        For({
            each: items,
            key: (s) => s,
            children: (s) => h('span', {}, () => `${ s }:${ tick() }`)
        });

        // The contract violation is reported - once, not per occurrence.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('duplicate key');
        warn.mockRestore();

        // Both occurrences rendered a row; the first entry was displaced
        // from the key map by the duplicate.
        expect(subscriberCount(tick)).toBe(2);

        // 'x' leaves the list: the surviving entry is disposed in the
        // removal pass, the displaced orphan in the next run's flush.
        setItems(['y']);
        expect(subscriberCount(tick)).toBe(1);

        setItems([]);
        expect(subscriberCount(tick)).toBe(0);
    });

    it('createEffect: a first run that throws leaves no subscription behind', () =>
    {
        const [count, setCount] = createSignal(0);

        expect(() => createEffect(() =>
        {
            count();
            throw new Error('boom');
        })).toThrow('boom');

        expect(subscriberCount(count)).toBe(0);

        // The dead effect must not re-run (and re-throw) inside the setter.
        expect(() => setCount(1)).not.toThrow();
    });

    it('Portal: destroyPortal releases the content subscriptions', () =>
    {
        const target = document.createElement('div');
        const [count] = createSignal(0);

        const placeholder = Portal({ target, children: () => h('p', {}, () => String(count())) });
        expect(subscriberCount(count)).toBe(1);

        destroyPortal(placeholder);
        expect(subscriberCount(count)).toBe(0);
    });
});

describe('Untracked render factories', () =>
{
    it('Show: a synchronous signal read in the factory does not rebuild the branch', () =>
    {
        const [show, setShow] = createSignal(true);
        const [label, setLabel] = createSignal('a');
        let builds = 0;

        const el = Show({ when: show, children: () =>
        {
            builds++;
            // Read OUTSIDE any reactive child - before the untrack fix this
            // subscribed the branch effect and rebuilt the subtree (losing
            // DOM state) on every label change.
            const text = label();
            return h('p', {}, text);
        } });

        expect(builds).toBe(1);
        const firstNode = el.firstChild;

        setLabel('b');
        expect(builds).toBe(1);
        expect(el.firstChild).toBe(firstNode);

        // The branch still swaps on the tracked condition.
        setShow(false);
        setShow(true);
        expect(builds).toBe(2);
    });

    it('Switch: a synchronous signal read in a case render does not rebuild it', () =>
    {
        const [which, setWhich] = createSignal<'a' | 'b'>('a');
        const [label, setLabel] = createSignal('x');
        let builds = 0;

        Switch({ children: [
            Match({ when: () => which() === 'a', children: () =>
            {
                builds++;
                return h('p', {}, label());
            } }),
            Match({ when: () => which() === 'b', children: () => h('p', {}, 'b') })
        ] });

        expect(builds).toBe(1);

        setLabel('y');
        expect(builds).toBe(1);

        setWhich('b');
        setWhich('a');
        expect(builds).toBe(2);
    });

    it('For: a synchronous signal read in renderItem does not re-reconcile the list', () =>
    {
        const [items, setItems] = createSignal([1, 2, 3]);
        const [label, setLabel] = createSignal('x');
        let builds = 0;

        For({
            each: items,
            key: (n) => n,
            children: (n) =>
            {
                builds++;
                return h('span', {}, `${ n }:${ label() }`);
            }
        });

        expect(builds).toBe(3);

        // Before the untrack fix this re-ran the reconcile effect; keys are
        // unchanged so rows were reused, but the wasted pass also resubscribed
        // the whole list to `label`.
        setLabel('y');
        expect(builds).toBe(3);

        setItems([1, 2, 3, 4]);
        expect(builds).toBe(4);
    });
});

describe('Finalization probe', () =>
{
    const exposedGc = (globalThis as { gc?: () => void }).gc;

    // Needs node --expose-gc; skipped in normal runs so CI never depends on
    // real GC timing.
    it.skipIf(!exposedGc)('an unmounted subtree is collectable', async () =>
    {
        const container = document.createElement('div');
        const [count] = createSignal(0);

        let probe: WeakRef<HTMLElement> | null = null;

        (function mount(): void
        {
            const el = h('p', {}, () => String(count()));
            probe = new WeakRef(el);
            render(() => el, container);
        })();

        render(() => h('p', {}, 'static'), container);

        for (let i = 0; i < 5 && probe!.deref() !== undefined; i++)
        {
            exposedGc!();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(probe!.deref()).toBeUndefined();
    });
});
