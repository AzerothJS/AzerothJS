// @azerothjs/testing: the utilities themselves, plus the repo's own test
// patterns re-expressed through them as proof they carry real suites.

import { describe, it, expect, afterEach } from 'vitest';
import { renderTest, cleanup, leakGuard, fire } from '@azerothjs/testing';
import { createSignal, createEffect, subscriberCount } from '@azerothjs/reactivity';
import { h, Show, For, tmpl, bindProps } from '@azerothjs/core';

// This repo runs vitest without injected globals, so auto-cleanup cannot
// self-register - this is the documented manual form.
afterEach(() => cleanup());

describe('renderTest', () =>
{
    it('mounts attached to the document and tears down on unmount', () =>
    {
        const [count, setCount] = createSignal(0);

        const { container, unmount } = renderTest(() =>
            h('p', {}, () => `count: ${ count() }`));

        expect(document.body.contains(container)).toBe(true);
        expect(container.textContent).toBe('count: 0');

        setCount(1);
        expect(container.textContent).toBe('count: 1');

        unmount();
        expect(document.body.contains(container)).toBe(false);
        expect(subscriberCount(count)).toBe(0);

        // Idempotent.
        expect(() => unmount()).not.toThrow();
    });

    it('cleanup() unmounts everything still mounted', () =>
    {
        const [a] = createSignal('a');
        const first = renderTest(() => h('p', {}, () => a()));
        const second = renderTest(() => h('p', {}, () => a()));

        expect(subscriberCount(a)).toBe(2);
        expect(document.body.contains(first.container)).toBe(true);
        expect(document.body.contains(second.container)).toBe(true);

        cleanup();

        expect(subscriberCount(a)).toBe(0);
        expect(document.body.contains(first.container)).toBe(false);
        expect(document.body.contains(second.container)).toBe(false);
    });
});

describe('leakGuard', () =>
{
    it('passes when teardown released every subscription', () =>
    {
        const [count] = createSignal(0);
        const check = leakGuard(count);

        const { unmount } = renderTest(() => h('p', {}, () => String(count())));
        unmount();

        expect(() => check()).not.toThrow();
    });

    it('throws naming the getter when a subscription survives', () =>
    {
        const [count] = createSignal(0);
        const check = leakGuard(count);

        // A deliberately leaked effect: created OUTSIDE any root, so no
        // teardown path exists until we dispose it by hand.
        const dispose = createEffect(() =>
        {
            count();
        });

        expect(() => check()).toThrow(/getter #0: 0 -> 1/);

        dispose();
        expect(() => check()).not.toThrow();
    });
});

describe('fire', () =>
{
    it('dispatches bubbling events that reach DELEGATED handlers', () =>
    {
        // bindProps delegates click to a document-level listener - exactly
        // the case a non-bubbling Event misses.
        const make = tmpl('<button>go</button>');
        let clicks = 0;

        const { container, unmount } = renderTest(() =>
        {
            const button = make();
            bindProps(button, { onClick: () => clicks++ });
            return button;
        });

        fire(container.firstChild as HTMLElement, 'click');
        expect(clicks).toBe(1);
        unmount();
    });
});

describe('repo patterns re-expressed (proof of carry)', () =>
{
    it('Show: branch swap releases the hidden branch (leak-regression suite shape)', () =>
    {
        const [show, setShow] = createSignal(true);
        const [count, setCount] = createSignal(0);
        const check = leakGuard(count);
        const seen: number[] = [];

        const { unmount } = renderTest(() =>
            Show({ when: show, children: () => h('p', {}, () =>
            {
                seen.push(count());
                return String(count());
            }) }));

        expect(seen).toEqual([0]);

        setShow(false);
        setCount(1);
        expect(seen).toEqual([0]);

        unmount();
        check();
    });

    it('For: rows render, reorder, and release (lifetime suite shape)', () =>
    {
        const [items, setItems] = createSignal([1, 2, 3]);
        const [tick] = createSignal(0);
        const check = leakGuard(tick, items);

        const { container, unmount } = renderTest(() =>
            h('ul', {}, For({
                each: items,
                key: (n) => n,
                children: (n) => h('li', {}, () => `${ n }:${ tick() }`)
            })));

        expect(container.querySelectorAll('li')).toHaveLength(3);

        setItems([3, 1]);
        expect(container.querySelectorAll('li')).toHaveLength(2);
        expect(container.textContent).toBe('3:01:0');

        unmount();
        check();
    });
});
