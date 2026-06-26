// @vitest-environment happy-dom
//
// Cross-module integration: a realistic component tree combining h(), Show, For,
// Switch/Match, signals/memos, classList/styleMap, refs, and delegated events,
// driven through render() and torn down with no leaks. Real reactive core + real
// happy-dom, no mocks. Exercises the full lifecycle: mount -> reactive update ->
// user interaction -> teardown.
import { describe, it, expect } from 'vitest';
import { createSignal, createMemo, batch, subscriberCount, type Getter, type Setter } from '@azerothjs/reactivity';
import { h, render, Show, For, Switch, Match, classList, styleMap, createRef } from '@azerothjs/renderer';

// `done` is a per-todo signal: the idiomatic way to get per-row reactivity from a
// keyed <For>, whose reused element keeps its ORIGINAL item closure (it does not
// re-invoke the row render with a replacement object). Mutating a plain `done`
// field on a fresh array object would NOT update an already-mounted row.
interface Todo { id: number; text: string; done: Getter<boolean>; setDone: Setter<boolean> }

function makeTodo(id: number, text: string): Todo
{
    const [done, setDone] = createSignal(false);
    return { id, text, done, setDone };
}

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('integration — a reactive todo widget', () =>
{
    it('mounts, reacts, handles interaction, and tears down cleanly', () =>
    {
        const [todos, setTodos] = createSignal<Todo[]>([
            makeTodo(1, 'learn'),
            makeTodo(2, 'build')
        ]);
        const [filter, setFilter] = createSignal<'all' | 'active'>('all');

        const remaining = createMemo(() => todos().filter((t) => !t.done()).length);

        const visible = createMemo(() =>
            filter() === 'active' ? todos().filter((t) => !t.done()) : todos());

        const listRef = createRef<HTMLUListElement>();

        function App(): HTMLElement
        {
            return h('section', { class: 'app' },
                // Header with a reactive count + reactive style.
                h('h1', { style: styleMap({ color: () => (remaining() === 0 ? 'green' : 'black') }) },
                    () => `${ remaining() } left`),

                // Filter toggle button (delegated click).
                h('button', {
                    class: classList({ btn: true, active: () => filter() === 'active' }),
                    onClick: () => setFilter((f) => (f === 'all' ? 'active' : 'all'))
                }, () => `filter: ${ filter() }`),

                // The list, keyed by id.
                h('ul', { ref: listRef }, For({
                    each: visible,
                    key: (t) => t.id,
                    children: (t) => h('li', { 'data-id': String(t.id), class: classList({ done: t.done }) },
                        h('span', {}, t.text),
                        h('button', {
                            class: 'toggle',
                            onClick: () =>
                            {
                                // Toggle the row's own signal, then nudge the list memo so
                                // the "active" filter re-derives visibility.
                                t.setDone((d) => !d);
                                setTodos((list) => [...list]);
                            }
                        }, 'x'))
                })),

                // Empty-state via Show + Switch for richer messaging.
                Show({
                    when: () => visible().length === 0,
                    children: () => Switch({
                        fallback: () => h('p', { class: 'empty' }, 'Nothing here'),
                        children: [
                            Match({
                                when: () => filter() === 'active',
                                children: () => h('p', { class: 'empty-active' }, 'All done!')
                            })
                        ]
                    })
                }));
        }

        const container = makeContainer();
        render(App, container);

        // --- Mount assertions ---
        expect(container.querySelector('h1')!.textContent).toBe('2 left');
        expect(container.querySelectorAll('li').length).toBe(2);
        expect(listRef.current).not.toBeNull();
        expect(listRef.current).toBe(container.querySelector('ul'));
        expect(container.querySelector('h1')!.style.color).toBe('black');

        // --- Interaction: toggle the first todo done ---
        const firstToggle = container.querySelector('li[data-id="1"] .toggle') as HTMLElement;
        const firstLi = container.querySelector('li[data-id="1"]')!;
        firstToggle.click();
        expect(container.querySelector('h1')!.textContent).toBe('1 left');
        expect(firstLi.classList.contains('done')).toBe(true);
        // Same li element reused (keyed reconcile, not rebuild).
        expect(container.querySelector('li[data-id="1"]')).toBe(firstLi);

        // --- Interaction: switch to the "active" filter ---
        const filterBtn = container.querySelector('.btn') as HTMLElement;
        filterBtn.click();
        expect(filterBtn.classList.contains('active')).toBe(true);
        // Only the not-done todo (id 2) is visible now.
        expect(container.querySelectorAll('li').length).toBe(1);
        expect(container.querySelector('li')!.getAttribute('data-id')).toBe('2');

        // --- Reactive update: finish the remaining todo -> empty active state ---
        const secondToggle = container.querySelector('li[data-id="2"] .toggle') as HTMLElement;
        secondToggle.click();
        expect(container.querySelector('h1')!.textContent).toBe('0 left');
        expect(container.querySelector('h1')!.style.color).toBe('green');
        expect(container.querySelectorAll('li').length).toBe(0);
        // Switch chose the "active filter" empty message.
        expect(container.querySelector('.empty-active')).not.toBeNull();
        expect(container.querySelector('.empty')).toBeNull();

        // --- Batched update: reset everything in one tick ---
        batch(() =>
        {
            setTodos([makeTodo(3, 'new')]);
            setFilter('all');
        });
        expect(container.querySelectorAll('li').length).toBe(1);
        expect(container.querySelector('li')!.getAttribute('data-id')).toBe('3');
        expect(container.querySelector('h1')!.textContent).toBe('1 left');

        // --- Teardown: re-render the container disposes the whole tree ---
        render(() => h('div', {}, 'gone'), container);
        expect(container.querySelector('section')).toBeNull();
        // Updating the old signals no longer touches the DOM.
        setTodos([makeTodo(99, 'ghost')]);
        expect(container.textContent).toBe('gone');
        container.remove();
    });

    it('disposes all nested control-flow effects when the mount is torn down', () =>
    {
        const [show, setShow] = createSignal(true);
        const [label] = createSignal('hi');
        const [rows] = createSignal([{ id: 1 }, { id: 2 }]);

        const container = makeContainer();
        render(() => h('div', {},
            Show({
                when: show,
                children: () => h('section', {},
                    h('p', {}, () => label()),
                    h('ul', {}, For({
                        each: rows,
                        key: (r) => r.id,
                        children: (r) => h('li', {}, () => `row ${ r.id } ${ label() }`)
                    })))
            })), container);

        // label is read by the <p> and both <li> rows -> 3 subscribers.
        expect(subscriberCount(label)).toBe(3);
        // show drives the Show effect.
        expect(subscriberCount(show)).toBe(1);

        // render() owns the mount in its own root; re-rendering the container
        // disposes that root and every nested control-flow effect with it.
        render(() => h('div', {}, 'empty'), container);
        expect(subscriberCount(label)).toBe(0);
        expect(subscriberCount(show)).toBe(0);

        // Writing afterwards is inert (no leaked effect re-runs).
        setShow(false);
        expect(subscriberCount(show)).toBe(0);
        expect(container.textContent).toBe('empty');
        container.remove();
    });
});
