// @vitest-environment happy-dom
//
// Renderer child-consistency guarantees (v1 hardening pass):
//  1. SVG / MathML elements are created in the correct namespace (a plain createElement lands them in
//     XHTML and the browser refuses to paint them), and SVG/MathML nodes append as nodes (not stringified).
//  2. A control-flow branch (Show/Switch/Dynamic) that returns an ARRAY or a fragment renders its items
//     as DIRECT children of the co-range - never inside a `display:contents` wrapper, which is invalid in
//     <select>/<table>. This matches the reactive-array-hole guarantee.
import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render, Show, Switch, Match } from '@azerothjs/renderer';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('SVG / MathML namespaces', () =>
{
    it('an <svg> subtree is created in the SVG namespace', () =>
    {
        const c = mount(() => h('svg', { viewBox: '0 0 10 10' }, h('circle', { cx: '5', cy: '5', r: '4' })));
        const svg = c.querySelector('svg')!;
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.firstElementChild?.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.firstElementChild?.localName).toBe('circle');
    });

    it('a <math> subtree is created in the MathML namespace', () =>
    {
        const c = mount(() => h('math', {}, h('mrow', {}, h('mi', {}, 'x'))));
        const math = c.querySelector('math')!;
        expect(math.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
        expect(math.firstElementChild?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
    });

    it('a div (HTML) stays in the XHTML namespace', () =>
    {
        const c = mount(() => h('div', {}, 'hi'));
        expect(c.querySelector('div')!.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    });
});

describe('control-flow array branches in restricted parents', () =>
{
    it('a Show branch returning an array of <option> renders direct option children (no wrapper)', () =>
    {
        const [on] = createSignal(true);
        const c = mount(() =>
            h('select', {},
                Show({ when: on, children: () => [h('option', {}, 'a'), h('option', {}, 'b')] })
            ));
        const select = c.querySelector('select')!;
        expect(select.querySelector('span')).toBeNull();
        expect(select.querySelectorAll('option').length).toBe(2);
    });

    it('a Switch/Match array branch also renders direct children', () =>
    {
        const [n] = createSignal(1);
        const c = mount(() =>
            h('select', {},
                Switch({ children: Match({ when: () => n() === 1, children: () => [h('option', {}, 'x'), h('option', {}, 'y')] }) })
            ));
        const select = c.querySelector('select')!;
        expect(select.querySelector('span')).toBeNull();
        expect(select.querySelectorAll('option').length).toBe(2);
    });

    it('multi-child Show (<A/><B/>) renders both as direct children', () =>
    {
        const [on] = createSignal(true);
        const c = mount(() =>
            h('ul', {},
                Show({ when: on, children: () => [h('li', {}, '1'), h('li', {}, '2'), h('li', {}, '3')] })
            ));
        const ul = c.querySelector('ul')!;
        expect(ul.querySelectorAll('li').length).toBe(3);
        // direct children, not wrapped
        expect(Array.from(ul.children).every((el) => el.tagName === 'LI')).toBe(true);
    });
});
