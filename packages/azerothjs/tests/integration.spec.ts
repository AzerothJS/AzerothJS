// @vitest-environment happy-dom
//
// End-to-end integration for the azerothjs umbrella: every symbol used below is
// imported from 'azerothjs' ALONE, proving the umbrella surface is sufficient to
// build a real app (reactivity + renderer + control flow + store + form + SSR) without
// reaching into the underlying packages. These are genuine mount -> update -> interact
// scenarios composing multiple features, NOT re-tests of any single package's unit
// behavior (those live in the source packages). No mocks: real signals, real happy-dom
// nodes, real delegated events, real string-mode SSR.
import { describe, it, expect } from 'vitest';
import {
    createSignal,
    createStore,
    createForm,
    combine,
    required,
    minLength,
    email,
    h,
    render,
    Show,
    For,
    classList,
    renderToString,
    renderToStaticMarkup,
    createRoot
} from 'azerothjs';

// Mount a component into a container that is attached to document.body so the renderer's
// DELEGATED event handlers (which listen at the document level) fire on real .click().
function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('core CSR - signals + h + control flow, then a store driving the same UI', () =>
{
    it('a signal + Show + For build a live todo list that reacts to clicks', () =>
    {
        interface Todo
        {
            id: number;
            text: string;
        }

        const [todos, setTodos] = createSignal<Todo[]>([{ id: 1, text: 'first' }]);
        const [showList, setShowList] = createSignal(true);
        let nextId = 2;

        const container = mount(() =>
            h('div', {},
                h('button', { class: 'add', onClick: () => setTodos((t) => [...t, { id: nextId, text: `item ${ nextId++ }` }]) }, 'add'),
                h('button', { class: 'toggle', onClick: () => setShowList((v) => !v) }, 'toggle'),
                Show({
                    when: showList,
                    fallback: () => h('p', { class: 'empty' }, 'hidden'),
                    children: () => h('ul', {},
                        For({
                            each: todos,
                            key: (t: Todo) => t.id,
                            children: (t: Todo, index: () => number) => h('li', {}, () => `${ index() + 1 }: ${ t.text }`)
                        }))
                })));

        const addBtn = container.querySelector('.add') as HTMLButtonElement;
        const toggleBtn = container.querySelector('.toggle') as HTMLButtonElement;

        // Initial render: list visible with the seeded row.
        let items = container.querySelectorAll('li');
        expect(items.length).toBe(1);
        expect(items[0]?.textContent).toBe('1: first');

        // Click "add" twice -> For appends two rows, reusing the existing one.
        const firstRow = container.querySelector('li')!;
        addBtn.click();
        addBtn.click();
        items = container.querySelectorAll('li');
        expect(items.length).toBe(3);
        expect(Array.from(items, (li) => li.textContent)).toEqual(['1: first', '2: item 2', '3: item 3']);
        // Keyed reuse: the original row is the SAME element instance, not rebuilt.
        expect(container.querySelector('li')).toBe(firstRow);

        // Toggle Show off -> list torn down, fallback shown.
        toggleBtn.click();
        expect(container.querySelector('ul')).toBeNull();
        expect(container.querySelector('.empty')!.textContent).toBe('hidden');

        // Toggle back on -> list rebuilt with the current (3) items.
        toggleBtn.click();
        expect(container.querySelectorAll('li').length).toBe(3);

        container.remove();
    });

    it('a classList binding from core reactively toggles a class on click', () =>
    {
        const [active, setActive] = createSignal(false);
        const container = mount(() =>
            h('button', { class: classList({ btn: true, active }), onClick: () => setActive((v) => !v) }, 'x'));

        const btn = container.querySelector('button')!;
        expect(btn.classList.contains('btn')).toBe(true);
        expect(btn.classList.contains('active')).toBe(false);

        btn.click();
        expect(btn.classList.contains('active')).toBe(true);
        btn.click();
        expect(btn.classList.contains('active')).toBe(false);

        container.remove();
    });

    it('a createStore singleton drives two independent views and stays in sync via a click', () =>
    {
        const useCart = createStore(() =>
        {
            const [items, setItems] = createSignal<string[]>([]);
            return {
                items,
                count: () => items().length,
                add: (name: string) => setItems((list) => [...list, name])
            };
        });

        const container = mount(() =>
        {
            const cart = useCart();
            return h('div', {},
                // A control reading the store...
                h('button', { class: 'buy', onClick: () => cart.add('apple') }, 'buy'),
                // ...and two separate views of the SAME singleton instance.
                h('span', { class: 'badge' }, () => `count: ${ cart.count() }`),
                h('ul', { class: 'list' },
                    For({
                        each: cart.items,
                        key: (name: string, i: number) => `${ i }:${ name }`,
                        children: (name: string) => h('li', {}, name)
                    })));
        });

        const buyBtn = container.querySelector('.buy') as HTMLButtonElement;
        const badge = container.querySelector('.badge')!;

        expect(badge.textContent).toBe('count: 0');
        expect(container.querySelectorAll('li').length).toBe(0);

        buyBtn.click();
        buyBtn.click();

        // One store driving both views in lockstep through the DOM.
        expect(badge.textContent).toBe('count: 2');
        const rows = container.querySelectorAll('li');
        expect(Array.from(rows, (li) => li.textContent)).toEqual(['apple', 'apple']);

        container.remove();
    });
});

describe('core form - createForm wired to real inputs with validation + submit', () =>
{
    it('binds inputs, validates live, blocks an invalid submit, then submits when valid', () =>
    {
        const submitted: Array<{ name: string; email: string }> = [];
        let form!: ReturnType<typeof build>;

        function build(): ReturnType<typeof createForm<{ name: string; email: string }>>
        {
            return createForm({
                initial: { name: '', email: '' },
                validate: {
                    name: combine(required(), minLength(2)),
                    email: combine(required(), email())
                },
                onSubmit: (values) =>
                {
                    submitted.push(values);
                }
            });
        }

        // The form and its rendered tree share one root so the validation effect and the
        // input value bindings have a common owner.
        const container = document.createElement('div');
        document.body.appendChild(container);
        createRoot(() =>
        {
            form = build();
            render(() =>
                h('form', { onSubmit: form.handleSubmit },
                    h('input', { class: 'name', ...form.register('name') }),
                    h('input', { class: 'email', ...form.register('email') }),
                    h('p', { class: 'name-err' }, () => (form.touched().name ? form.errors().name : '')),
                    h('button', { type: 'submit' }, 'save')),
            container);
        });

        const nameInput = container.querySelector('.name') as HTMLInputElement;
        const emailInput = container.querySelector('.email') as HTMLInputElement;
        const formEl = container.querySelector('form') as HTMLFormElement;

        // Initial bound values empty; both required errors live but not yet displayed.
        expect(nameInput.value).toBe('');
        expect(form.isValid()).toBe(false);

        // Type an invalid (too-short) name -> live validation, value flows to form state.
        nameInput.value = 'A';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(form.values().name).toBe('A');
        expect(form.errors().name).toBe('Must be at least 2 characters');

        // Submitting while invalid is blocked, and marks every field touched (so the
        // error text now renders into the DOM).
        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(submitted).toEqual([]);
        expect(form.touched().name).toBe(true);
        expect(container.querySelector('.name-err')!.textContent).toBe('Must be at least 2 characters');

        // Fix both fields, then submit successfully.
        nameInput.value = 'Ada';
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.value = 'ada@example.com';
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(form.isValid()).toBe(true);

        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(submitted).toEqual([{ name: 'Ada', email: 'ada@example.com' }]);
        // The displayed error clears once the field is valid.
        expect(container.querySelector('.name-err')!.textContent).toBe('');

        container.remove();
    });
});

describe('core SSR - renderToString / renderToStaticMarkup from the umbrella', () =>
{
    // A component built entirely from core, usable on both server (string mode) and client.
    interface Item
    {
        id: number;
        label: string;
    }

    function Catalog(props: { items: Item[]; heading: boolean }): HTMLElement
    {
        return h('section', {},
            Show({
                when: () => props.heading,
                children: () => h('h1', {}, 'Catalog')
            }),
            h('ul', {},
                For({
                    each: props.items,
                    key: (it: Item) => it.id,
                    children: (it: Item) => h('li', { 'data-id': it.id }, it.label)
                })));
    }

    const items: Item[] = [
        { id: 1, label: 'alpha' },
        { id: 2, label: 'beta' }
    ];

    it('renderToString emits the active Show branch, every For row, and hydration markers', () =>
    {
        const html = renderToString(() => Catalog({ items, heading: true }));

        // Structure + content are present (markers are interleaved, so assert on substrings).
        expect(html).toContain('<section');
        expect(html).toContain('<h1');
        expect(html).toContain('Catalog');
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        expect(html).toContain('data-id="1"');
        expect(html).toContain('data-id="2"');
        // renderToString (unlike renderToStaticMarkup) carries the co-range hydration
        // anchors the client adopts with hydrate() - proving it is the hydration-ready entry.
        expect(html).toContain('<!--azc:for-->');
        expect(html).toContain('<!--/azc-->');
    });

    it('renderToString evaluates Show once and omits the inactive branch', () =>
    {
        const html = renderToString(() => Catalog({ items, heading: false }));
        // heading=false -> no <h1>/Catalog text, but the list still serializes.
        expect(html).not.toContain('<h1');
        expect(html).not.toContain('Catalog');
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
    });

    it('renderToStaticMarkup produces clean, marker-free HTML for the same component', () =>
    {
        const html = renderToStaticMarkup(() => Catalog({ items, heading: true }));

        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        // Static markup carries NONE of the co-range hydration anchors renderToString
        // emits (verified non-vacuous: those exact markers appear in the renderToString
        // output above).
        expect(html).not.toContain('<!--azc:for-->');
        expect(html).not.toContain('<!--/azc-->');
        expect(html).not.toContain('<!--azc:show-->');
    });
});
