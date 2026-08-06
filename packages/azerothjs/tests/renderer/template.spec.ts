// @vitest-environment happy-dom
//
// Behavioral coverage for the compiler-emitted template runtime: tmpl()
// (template.ts) plus bindHole/bindSlot (h.ts). These mirror exactly what the
// `dom` compile target emits for a static region with dynamic holes/slots:
// one cloned template, then reactive holes bound at <!--[--><!--]--> anchors and
// component slots placed at marker comments.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, h, render, Show } from 'azerothjs';
import { tmpl, bindHole, bindSlot } from 'azerothjs/internal';
import { parseContainerFor } from '../../src/renderer/namespace.ts';

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('tmpl', () =>
{
    it('returns a function that clones the interned template structure', () =>
    {
        const make = tmpl('<li class="row">static</li>');
        const a = make();
        const b = make();
        expect(a.tagName).toBe('LI');
        expect(a.getAttribute('class')).toBe('row');
        expect(a.textContent).toBe('static');
        // Each call is a fresh, independent clone.
        expect(a).not.toBe(b);
    });

    it('clones preserve nested structure', () =>
    {
        const make = tmpl('<div><span>a</span><span>b</span></div>');
        const el = make();
        expect(el.querySelectorAll('span').length).toBe(2);
        expect(el.textContent).toBe('ab');
    });

    it('a template rooted at an SVG CHILD lands in the SVG namespace, like h() does', () =>
    {
        // The HTML fragment parser enters foreign content only at <svg>/<math>, so a region
        // whose root is `<g>`/`<path>` - what a For row or a nested region serializes to -
        // used to clone as an HTMLUnknownElement and never paint, while the SAME markup
        // built through h() (the SSR/hydrate path) was namespaced correctly. One artifact,
        // two DOMs. Both paths now answer identically.
        const SVG = 'http://www.w3.org/2000/svg';
        const group = tmpl('<g><path d="M0 0"></path></g>')();

        expect(group.namespaceURI).toBe(SVG);
        expect(group.firstChild instanceof SVGElement).toBe(true);
        expect((group.firstChild as Element).namespaceURI).toBe(SVG);
        expect(group.namespaceURI).toBe(h('g', {}).namespaceURI);
    });

    it('leaves an svg root and plain HTML alone - only a foreign CHILD root needs the wrapper', () =>
    {
        expect(tmpl('<svg><circle r="1"></circle></svg>')().namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(tmpl('<div><span>a</span></div>')().namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    });

    it('preserves camelCase foreign tag names through the wrapped parse', () =>
    {
        // `clipPath`/`feGaussianBlur` are case-sensitive in SVG; an HTML parse outside
        // foreign content would lowercase them into a different element.
        expect(tmpl('<clipPath><rect></rect></clipPath>')().tagName).toBe('clipPath');
        expect(tmpl('<feGaussianBlur stdDeviation="2"></feGaussianBlur>')().tagName).toBe('feGaussianBlur');
    });

    it('decides the parse container per root tag - svg children, math children, neither', () =>
    {
        // The DECISION is ours and is asserted here. What the parser then does inside the
        // container (the foreignObject -> HTML transition, MathML namespacing) belongs to
        // the DOM implementation, and this test environment implements neither, so those
        // are verified in a real browser rather than asserted against a stub here.
        expect(parseContainerFor('g')).toBe('svg');
        expect(parseContainerFor('feGaussianBlur')).toBe('svg');
        expect(parseContainerFor('foreignObject')).toBe('svg');
        expect(parseContainerFor('mi')).toBe('math');
        expect(parseContainerFor('svg')).toBeNull();
        expect(parseContainerFor('math')).toBeNull();
        expect(parseContainerFor('div')).toBeNull();
        // `a`, `script`, `style`, `title` are deliberately HTML: far commoner there.
        expect(parseContainerFor('a')).toBeNull();
    });
});

describe('bindHole', () =>
{
    it('drives a reactive text hole between anchors, patching in place', () =>
    {
        createRoot((dispose) =>
        {
            const [name, setName] = createSignal('Ada');
            // The template the compiler would emit for <li>{name()}</li>:
            const make = tmpl('<li><!--[--><!--]--></li>');
            const li = make();
            // firstChild is the <!--[--> open anchor.
            bindHole(li.firstChild!, () => name());
            expect(li.textContent).toBe('Ada');

            setName('Grace');
            expect(li.textContent).toBe('Grace');
            dispose();
        });
    });

    it('places a static (non-function) hole value once and removes the anchors', () =>
    {
        const make = tmpl('<p><!--[--><!--]--></p>');
        const p = make();
        bindHole(p.firstChild!, 'literal');
        expect(p.textContent).toBe('literal');
        // No leftover comment anchors.
        expect(Array.from(p.childNodes).some((n) => n.nodeType === 8)).toBe(false);
    });

    it('materialises an element-valued reactive hole', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            const make = tmpl('<div><!--[--><!--]--></div>');
            const div = make();
            bindHole(div.firstChild!, () => (n() > 0 ? h('strong', {}, 'big') : 'small'));
            expect(div.textContent).toBe('small');
            expect(div.querySelector('strong')).toBeNull();

            setN(1);
            expect(div.querySelector('strong')).not.toBeNull();
            expect(div.querySelector('strong')!.textContent).toBe('big');
            dispose();
        });
    });
});

describe('bindSlot', () =>
{
    it('inserts a component\'s output at the marker and removes the marker', () =>
    {
        const container = makeContainer();
        render(() =>
        {
            // Template for <ul><Show .../></ul>: a marker comment where the slot goes.
            const make = tmpl('<ul><!--slot--></ul>');
            const ul = make();
            const marker = ul.firstChild!;
            const [on] = createSignal(true);
            const result = Show({ when: on, children: () => h('li', {}, 'item') });
            bindSlot(marker, result);
            return ul;
        }, container);

        const ul = container.querySelector('ul')!;
        expect(ul.querySelector('li')!.textContent).toBe('item');
        // Marker comment removed.
        expect(Array.from(ul.childNodes).some((n) => n.nodeType === 8 && n.textContent === 'slot')).toBe(false);
        container.remove();
    });

    it('removes the marker and inserts nothing for a null result', () =>
    {
        const make = tmpl('<div><!--slot--></div>');
        const div = make();
        const marker = div.firstChild!;
        bindSlot(marker, null);
        // Marker gone, no replacement node added.
        expect(div.childNodes.length).toBe(0);
    });
});
