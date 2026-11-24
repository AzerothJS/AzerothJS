// @vitest-environment happy-dom
//
// Renderer child-consistency guarantees (v1 hardening pass):
//  1. SVG / MathML elements are created in the correct namespace (a plain createElement lands them in
//     XHTML and the browser refuses to paint them), and SVG/MathML nodes append as nodes (not stringified).
//  2. A control-flow branch (Show/Switch/Dynamic) that returns an ARRAY or a fragment renders its items
//     as DIRECT children of the co-range - never inside a `display:contents` wrapper, which is invalid in
//     <select>/<table>. This matches the reactive-array-hole guarantee.
import { describe, it, expect } from 'vitest';
import { createSignal, h, hydrate, render, Show, Switch, Match } from 'azerothjs';
import { hNS, tmpl } from 'azerothjs/internal';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('SVG / MathML namespaces', () =>
{
    it('creates detached shared tags and integration-point children in their authored namespace', () =>
    {
        const link = hNS('html', 'a', {}, 'caption');
        const title = hNS('svg', 'title', {}, link);
        const root = h('svg', {}, title);
        expect(root.firstChild).toBe(title);
        expect(title.namespaceURI).toBe(root.namespaceURI);
        expect(title.firstChild).toBe(link);
        expect(link.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
        expect(hNS('math', 'style', {}).namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
        expect(h('style', {}).namespaceURI).toBe(link.namespaceURI);
    });

    it('parses the same template root in its supplied context', () =>
    {
        expect(tmpl('<style></style>', 'html')().namespaceURI).toBe('http://www.w3.org/1999/xhtml');
        expect(tmpl('<style></style>', 'svg')().namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(tmpl('<g></g>', 'html')().namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    });

    it('builds parser-spelled foreign local names and adopts those elements in place', () =>
    {
        const view = (): HTMLElement => hNS('svg', 'svg', {}, hNS('svg', 'stYle', {}, '.x { fill: red; }'),
            hNS('svg', 'fOreignObject', {}), hNS('svg', 'tiTle', {}, 'Ink'), hNS('svg', 'dEsC', {}, 'Drawing'));
        const container = document.createElement('div');
        const original = view();
        container.appendChild(original);
        const children = Array.from(original.children);
        expect(children.map(el => el.localName)).toEqual(['style', 'foreignObject', 'title', 'desc']);
        hydrate(view, container);
        expect(container.firstChild).toBe(original);
        expect(original.childElementCount).toBe(children.length);
        for (const [i, child] of children.entries())
        {
            expect(original.children[i]).toBe(child);
        }
    });
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
