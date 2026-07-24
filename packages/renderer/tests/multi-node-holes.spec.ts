// @vitest-environment happy-dom
//
// Regression matrix for MULTI-NODE reactive holes - a hole whose value is an array
// (`{ items().map(...) }`) or a DocumentFragment (a reactively-returned `<For>`). Every render path
// must materialise those as DIRECT children of the real parent, never inside a `<span display:contents>`
// wrapper. The wrapper (the bug this guards) breaks `space-y-*`/`> child` selectors, is invalid inside
// `<ul>`/`<table>`/`<select>`, and injects HTML into `<svg>`.
//
// Crucially this targets the COMPILER-EMITTED runtime - bindContent (only-child hole) and bindHole
// (hole with siblings) - not just the manual h() child path that array-hole.spec covers. The original
// span bug lived in bindContent, which the h()-only tests never reached.
import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render, bindContent, bindHole, For } from '@azerothjs/renderer';
import { setDestroyHooks } from '../../component/src/destroy-hooks.ts';

function mount(build: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(build, container);
    return container;
}

/** The real child elements of `el` (skips text/comment nodes). */
function childTags(el: Element): string[]
{
    return [...el.children].map(c => c.tagName.toLowerCase());
}

describe('only-child hole (bindContent) renders a multi-node value as direct children', () =>
{
    it('array in a space-y container -> rows are DIRECT children, no wrapper span', () =>
    {
        const [rows] = createSignal([1, 2, 3]);
        const container = mount(() =>
        {
            const box = h('div', { class: 'space-y-5' });
            bindContent(box, () => rows().map(r => h('div', { class: 'row' }, String(r))));
            return box;
        });
        const box = container.querySelector('.space-y-5')!;
        expect(box.querySelectorAll('span').length).toBe(0);          // NO display:contents wrapper
        expect(childTags(box)).toEqual(['div', 'div', 'div']);        // the three rows are direct children
        // The direct-child selector space-y-* relies on would now match each row.
        expect([...box.children].every(c => c.classList.contains('row'))).toBe(true);
        container.remove();
    });

    it('array in <ul> -> <li> are direct children (a span would be an invalid list child)', () =>
    {
        const [items] = createSignal(['a', 'b']);
        const container = mount(() =>
        {
            const ul = h('ul', {});
            bindContent(ul, () => items().map(t => h('li', {}, t)));
            return ul;
        });
        const ul = container.querySelector('ul')!;
        expect(ul.querySelectorAll('span').length).toBe(0);
        expect(childTags(ul)).toEqual(['li', 'li']);
        container.remove();
    });

    it('array in <svg> -> <path> are direct children in the SVG namespace (no HTML span)', () =>
    {
        const [n] = createSignal([1, 2]);
        const container = mount(() =>
        {
            const svg = h('svg', {});
            bindContent(svg, () => n().map(() => h('path', { d: 'M0 0' })));
            return svg;
        });
        const svg = container.querySelector('svg')!;
        expect(svg.querySelectorAll('span').length).toBe(0);
        const paths = [...svg.children];
        expect(paths.length).toBe(2);
        expect(paths.every(p => p.namespaceURI === 'http://www.w3.org/2000/svg')).toBe(true);
        container.remove();
    });

    it('fragment value (a <For>) as only child -> rows are direct children, no wrapper', () =>
    {
        const [items] = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }]);
        const container = mount(() =>
        {
            const ul = h('ul', {});
            bindContent(ul, () => For({ each: items(), key: i => i.id, children: i => h('li', {}, String(i.id)) }));
            return ul;
        });
        const ul = container.querySelector('ul')!;
        expect(ul.querySelectorAll('span').length).toBe(0);
        expect(childTags(ul)).toEqual(['li', 'li', 'li']);
        container.remove();
    });

    it('transitions scalar -> array -> scalar with no leftover wrapper or nodes', () =>
    {
        const [value, setValue] = createSignal<unknown>('hello');
        const container = mount(() =>
        {
            const box = h('div', {});
            bindContent(box, () => value());
            return box;
        });
        const box = container.querySelector('div')!;
        expect(box.textContent).toBe('hello');

        setValue([h('em', {}, '1'), h('em', {}, '2')]);
        expect(box.querySelectorAll('span').length).toBe(0);
        expect(childTags(box)).toEqual(['em', 'em']);

        setValue('back');
        expect(box.textContent).toBe('back');
        expect(box.querySelectorAll('em').length).toBe(0);
        container.remove();
    });

    it('empty array leaves the element genuinely empty (no empty wrapper span)', () =>
    {
        const [rows, setRows] = createSignal<number[]>([1, 2]);
        const container = mount(() =>
        {
            const box = h('div', {});
            bindContent(box, () => rows().map(r => h('p', {}, String(r))));
            return box;
        });
        const box = container.querySelector('div')!;
        expect(box.querySelectorAll('p').length).toBe(2);
        setRows([]);
        expect(box.querySelectorAll('span').length).toBe(0);
        expect(box.children.length).toBe(0);
        container.remove();
    });
});

describe('sibling hole (bindHole) renders a fragment value as direct children', () =>
{
    it('a reactively-returned <For> beside a sibling in <ul> -> direct <li>, no wrapper span', () =>
    {
        const [items] = createSignal([{ id: 1 }, { id: 2 }]);
        const container = mount(() =>
        {
            const ul = h('ul', {});
            ul.appendChild(h('li', { class: 'header' }, 'H'));    // a real sibling forces the anchored path
            const open = document.createComment('[');
            const close = document.createComment(']');
            ul.appendChild(open);
            ul.appendChild(close);
            bindHole(open, () => For({ each: items(), key: i => i.id, children: i => h('li', {}, String(i.id)) }));
            return ul;
        });
        const ul = container.querySelector('ul')!;
        expect(ul.querySelectorAll('span').length).toBe(0);
        expect(childTags(ul)).toEqual(['li', 'li', 'li']);        // header + 2 For rows, all direct
        container.remove();
    });

    it('a STATIC (non-function) array child renders as direct children, not stringified', () =>
    {
        // A hole whose value is a static array (`{ [<li/>, <li/>] }`) reaches bindHole as a NON-function
        // child; it must render the nodes, not `String(array)` them into escaped source text.
        const container = mount(() =>
        {
            const ul = h('ul', {});
            ul.appendChild(h('li', { class: 'header' }, 'H'));
            const open = document.createComment('[');
            const close = document.createComment(']');
            ul.appendChild(open);
            ul.appendChild(close);
            bindHole(open, [h('li', {}, 'a'), h('li', {}, 'b')]);
            return ul;
        });
        const ul = container.querySelector('ul')!;
        expect(childTags(ul)).toEqual(['li', 'li', 'li']);        // header + a + b, all real elements
        expect(ul.textContent).toBe('Hab');                       // NOT the escaped array source
        expect(ul.textContent).not.toContain('<li>');
        container.remove();
    });

    it('a STATIC DocumentFragment child is spliced in as direct children', () =>
    {
        const container = mount(() =>
        {
            const ul = h('ul', {});
            const frag = document.createDocumentFragment();
            frag.appendChild(h('li', {}, 'x'));
            frag.appendChild(h('li', {}, 'y'));
            const open = document.createComment('[');
            const close = document.createComment(']');
            ul.appendChild(open);
            ul.appendChild(close);
            bindHole(open, frag);
            return ul;
        });
        const ul = container.querySelector('ul')!;
        expect(childTags(ul)).toEqual(['li', 'li']);
        expect(ul.querySelectorAll('span').length).toBe(0);
        container.remove();
    });
});

describe('manual h() child renders a fragment value as direct children', () =>
{
    it('h(el, () => For(...)) -> direct rows, no wrapper span', () =>
    {
        const [items] = createSignal([{ id: 1 }, { id: 2 }]);
        const container = mount(() => h('ul', {},
            () => For({ each: items(), key: i => i.id, children: i => h('li', {}, String(i.id)) })
        ));
        const ul = container.querySelector('ul')!;
        expect(ul.querySelectorAll('span').length).toBe(0);
        expect(childTags(ul)).toEqual(['li', 'li']);
        container.remove();
    });
});

describe('a nullish only-child hole renders nothing (no stray empty text node)', () =>
{
    it('an initially-null only-child hole leaves the element genuinely empty (:empty matches)', () =>
    {
        const [v] = createSignal<unknown>(null);
        const container = mount(() =>
        {
            const box = h('div', { class: 'slot' });
            bindContent(box, () => v());
            return box;
        });
        const box = container.querySelector('.slot')!;
        expect(box.childNodes.length).toBe(0);   // no empty text node -> `div:empty` still matches
        expect(box.textContent).toBe('');
        container.remove();
    });

    it('element -> null removes the element, leaving the hole empty; null -> array re-renders', () =>
    {
        const [v, setV] = createSignal<unknown>(h('p', {}, 'hi'));
        const container = mount(() =>
        {
            const box = h('div', {});
            bindContent(box, () => v());
            return box;
        });
        const box = container.querySelector('div')!;
        expect(box.querySelector('p')).not.toBeNull();

        setV(null);
        expect(box.childNodes.length).toBe(0);    // element gone, no leftover text node
        expect(box.querySelector('p')).toBeNull();

        setV([h('li', {}, 'a'), h('li', {}, 'b')]);
        expect(childTags(box)).toEqual(['li', 'li']);
        expect(box.querySelectorAll('span').length).toBe(0);
        container.remove();
    });
});

describe('lifecycle: node-bound destroy hooks fire when a multi-node hole swaps out', () =>
{
    it('runs destroyComponent on array items removed from an only-child hole (leak fix)', () =>
    {
        const [items, setItems] = createSignal([1, 2]);
        let destroyed = 0;
        const container = mount(() =>
        {
            const box = h('div', {});
            bindContent(box, () => items().map(n =>
            {
                const row = h('div', { class: 'row' }, String(n));
                setDestroyHooks(row, [() => destroyed++]);
                return row;
            }));
            return box;
        });
        expect(destroyed).toBe(0);

        setItems([]); // swap the array out -> old rows' node-bound hooks must run
        expect(destroyed).toBe(2);
        container.remove();
    });
});
