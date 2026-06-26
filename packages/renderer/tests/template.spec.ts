// @vitest-environment happy-dom
//
// Behavioral coverage for the compiler-emitted template runtime: tmpl()
// (template.ts) plus bindHole/bindSlot (h.ts). These mirror exactly what the
// `dom` compile target emits for a static region with dynamic holes/slots:
// one cloned template, then reactive holes bound at <!--[--><!--]--> anchors and
// component slots placed at marker comments.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot } from '@azerothjs/reactivity';
import { h, render, tmpl, bindHole, bindSlot, Show } from '@azerothjs/renderer';

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
            bindSlot(marker, result as unknown as Node);
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
