// hydrate() tests.
//
// These mirror a real SSR -> CSR handoff: render the component to a string, drop
// that markup into a container (as the browser would on page load), then
// hydrate() the SAME component over it and assert the existing nodes are
// adopted (===), interactivity is wired, and reactive updates hit the adopted
// nodes in place.

import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render, hydrate, Show, For } from '@azerothjs/renderer';
import { defineComponent, onMount } from '@azerothjs/component';
import { renderToString } from '@azerothjs/server';

/** Renders `component` to a string and loads it into a fresh container. */
function serverInto(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    container.innerHTML = renderToString(component);
    return container;
}

describe('hydrate - node adoption', () =>
{
    it('adopts existing elements without recreating them', () =>
    {
        const App = (): HTMLElement => h('div', { id: 'root' }, h('p', {}, 'hi'));
        const container = serverInto(App);

        const div = container.querySelector('#root');
        const p = container.querySelector('p');

        hydrate(App, container);

        expect(container.querySelector('#root')).toBe(div);
        expect(container.querySelector('p')).toBe(p);
    });

    it('wires event handlers onto the adopted element', () =>
    {
        const Counter = (): HTMLElement =>
        {
            const [n, setN] = createSignal(0);
            return h('button', { onClick: () => setN((v) => v + 1) }, () => `Count: ${ n() }`);
        };

        const container = serverInto(Counter);
        const btn = container.querySelector('button')!;
        expect(btn.textContent).toBe('Count: 0');

        hydrate(Counter, container);

        // Same node, now interactive.
        expect(container.querySelector('button')).toBe(btn);
        btn.dispatchEvent(new Event('click'));
        expect(btn.textContent).toBe('Count: 1');
    });

    it('adopts a reactive text node and updates it in place', () =>
    {
        const Counter = (): HTMLElement =>
        {
            const [n, setN] = createSignal(0);
            return h('button', { onClick: () => setN((v) => v + 1) }, () => `${ n() }`);
        };

        const container = serverInto(Counter);
        const btn = container.querySelector('button')!;
        const textNode = Array.from(btn.childNodes).find((node) => node.nodeType === 3) as Text;
        expect(textNode.data).toBe('0');

        hydrate(Counter, container);
        btn.dispatchEvent(new Event('click'));

        // The SAME text node was patched - not replaced.
        const after = Array.from(btn.childNodes).find((node) => node.nodeType === 3) as Text;
        expect(after).toBe(textNode);
        expect(textNode.data).toBe('1');
    });
});

describe('hydrate - components', () =>
{
    it('runs onMount exactly once', () =>
    {
        const mounted = vi.fn();
        const App = defineComponent(() =>
        {
            onMount(mounted);
            return h('div', {}, 'x');
        });

        const container = serverInto(() => App({}));
        expect(mounted).not.toHaveBeenCalled(); // server render must not mount

        hydrate(() => App({}), container);
        expect(mounted).toHaveBeenCalledTimes(1);
    });
});

describe('hydrate - Show', () =>
{
    it('adopts the rendered branch, then swaps reactively', () =>
    {
        const [show, setShow] = createSignal(true);
        const App = (): HTMLElement => h('div', {}, Show({
            when: show,
            fallback: () => h('span', {}, 'no'),
            children: () => h('p', { id: 'yes' }, 'yes')
        }));

        const container = serverInto(App);
        const p = container.querySelector('#yes');
        expect(p).not.toBeNull();

        hydrate(App, container);
        expect(container.querySelector('#yes')).toBe(p); // adopted, same node

        setShow(false);
        expect(container.querySelector('#yes')).toBeNull();
        expect(container.textContent).toContain('no');

        setShow(true);
        expect(container.querySelector('#yes')).not.toBeNull(); // rebuilt fresh
    });
});

describe('hydrate - For', () =>
{
    it('adopts existing rows and preserves their identity across reorder', () =>
    {
        const [items, setItems] = createSignal(['a', 'b', 'c']);
        const App = (): HTMLElement => h('ul', {}, For({
            each: items,
            key: (x) => x,
            children: (x) => h('li', { 'data-k': x }, x)
        }));

        const container = serverInto(App);
        expect(container.querySelectorAll('li')).toHaveLength(3);
        const liA = container.querySelector('[data-k="a"]');

        hydrate(App, container);
        expect(container.querySelector('[data-k="a"]')).toBe(liA); // adopted

        setItems(['c', 'a', 'b']);
        // Same DOM node, just moved - no recreation.
        expect(container.querySelector('[data-k="a"]')).toBe(liA);
        expect(Array.from(container.querySelectorAll('li')).map((li) => li.getAttribute('data-k'))).toEqual(['c', 'a', 'b']);
    });
});

// The whole point of the comment-marker change: control flow now SSRs and
// hydrates as DIRECT children of strict parents like <tbody>, where the old
// <span> wrapper was illegal (the HTML parser would hoist it out of the table).
describe('hydrate - control flow inside <tbody>', () =>
{
    it('SSRs <For> rows into <tbody> with no wrapper element, then adopts them', () =>
    {
        const [rows, setRows] = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const App = (): HTMLElement => h('table', {}, h('tbody', { id: 'tb' }, For({
            each: rows,
            key: (r) => r.id,
            children: (r) => h('tr', { 'data-id': String(r.id) }, h('td', {}, String(r.id)))
        })));

        const container = serverInto(App);

        // Server markup put the rows directly in <tbody> (no <span>), so the
        // benchmark-style selector matches even before hydration.
        expect(container.querySelector('#tb')!.querySelector('span')).toBeNull();
        expect(container.querySelectorAll('tbody > tr')).toHaveLength(3);
        const row2 = container.querySelector('[data-id="2"]');

        hydrate(App, container);
        expect(container.querySelector('[data-id="2"]')).toBe(row2); // adopted, not rebuilt

        // Reactivity works on the adopted rows.
        setRows([{ id: 1 }, { id: 3 }]);
        expect(Array.from(container.querySelectorAll('tbody > tr')).map((tr) => tr.getAttribute('data-id')))
            .toEqual(['1', '3']);
        expect(container.querySelector('#tb')!.querySelector('span')).toBeNull();
    });

    it('round-trips nested control flow (Show > For) via balanced anchors', () =>
    {
        const [on] = createSignal(true);
        const [rows] = createSignal([{ id: 1 }, { id: 2 }]);
        const App = (): HTMLElement => h('table', {}, h('tbody', { id: 'tb' }, Show({
            when: on,
            children: () => For({
                each: rows,
                key: (r) => r.id,
                children: (r) => h('tr', { 'data-id': String(r.id) }, h('td', {}, String(r.id)))
            })
        }) as unknown as HTMLElement));

        const container = serverInto(App);
        expect(container.querySelectorAll('tbody > tr')).toHaveLength(2);
        const row1 = container.querySelector('[data-id="1"]');

        // Balanced anchors: Show's close marker is matched past For's markers.
        hydrate(App, container);
        expect(container.querySelector('[data-id="1"]')).toBe(row1);
        expect(container.querySelectorAll('tbody > tr')).toHaveLength(2);
        expect(container.querySelector('#tb')!.querySelector('span')).toBeNull();
    });
});

describe('hydrate - mismatch fallback', () =>
{
    it('falls back to a full client render without throwing', () =>
    {
        const App = (): HTMLElement => h('div', { id: 'real' }, h('p', {}, 'real'));

        const container = document.createElement('div');
        // Deliberately wrong server markup.
        container.innerHTML = '<section><b>wrong</b></section>';

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(() => hydrate(App, container)).not.toThrow();
        warn.mockRestore();

        expect(container.querySelector('#real')).not.toBeNull();
        expect(container.textContent).toContain('real');
    });
});

describe('hydrate - re-render disposes the hydrated tree', () =>
{
    it('lets a later render() replace a hydrated mount', () =>
    {
        const App = (): HTMLElement => h('div', { id: 'a' }, 'a');
        const container = serverInto(App);

        hydrate(App, container);
        expect(container.querySelector('#a')).not.toBeNull();

        render(() => h('div', { id: 'b' }, 'b'), container);
        expect(container.querySelector('#a')).toBeNull();
        expect(container.querySelector('#b')).not.toBeNull();
    });
});
