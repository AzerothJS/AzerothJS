// @vitest-environment happy-dom
//
// A reactive array hole - `{ items().map(item => <option/>) }` - must render its items as DIRECT
// children of the real parent, not inside a `display:contents` wrapper element. A wrapper is ignored by
// `<select>`'s option model and breaks `<table>` row parsing, so a list inside those parents would
// silently not render (the regression this guards). Items must also update reactively.
import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('reactive array hole', () =>
{
    it('renders array items as DIRECT children of <select> (no wrapper span)', () =>
    {
        const [realms] = createSignal([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
        const container = mount(() => h('select', {},
            h('option', { value: '' }, 'placeholder'),
            () => realms().map(r => h('option', { value: String(r.id) }, r.name))
        ));
        const select = container.querySelector('select')!;
        expect(select.querySelectorAll('span').length).toBe(0);                    // no display:contents wrapper
        const directOptions = [...select.children].filter(c => c.tagName === 'OPTION');
        expect(directOptions.length).toBe(3);                                      // placeholder + 2 realms, all direct
        expect(directOptions.map(o => o.textContent)).toEqual(['placeholder', 'A', 'B']);
        container.remove();
    });

    it('updates the rendered items when the array changes', () =>
    {
        const [realms, setRealms] = createSignal([{ id: 1, name: 'A' }]);
        const container = mount(() => h('select', {},
            () => realms().map(r => h('option', { value: String(r.id) }, r.name))
        ));
        const select = container.querySelector('select')!;
        expect([...select.children].filter(c => c.tagName === 'OPTION').length).toBe(1);

        setRealms([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]);
        const opts = [...select.children].filter(c => c.tagName === 'OPTION');
        expect(opts.length).toBe(3);
        expect(select.querySelectorAll('span').length).toBe(0);

        setRealms([]); // empties cleanly
        expect([...select.children].filter(c => c.tagName === 'OPTION').length).toBe(0);
        container.remove();
    });

    it('transitions array -> single element -> array without leftover wrapper nodes', () =>
    {
        const [value, setValue] = createSignal<unknown>([h('span', { class: 'x' }, 'a'), h('span', { class: 'x' }, 'b')]);
        const container = mount(() => h('div', {}, () => value()));
        expect(container.querySelectorAll('span.x').length).toBe(2);

        setValue(h('p', { class: 'solo' }, 'one'));
        expect(container.querySelector('p.solo')).not.toBeNull();
        expect(container.querySelectorAll('span.x').length).toBe(0); // old array nodes gone

        setValue([h('em', {}, '1'), h('em', {}, '2'), h('em', {}, '3')]);
        expect(container.querySelectorAll('em').length).toBe(3);
        expect(container.querySelector('p.solo')).toBeNull();
        container.remove();
    });
});
