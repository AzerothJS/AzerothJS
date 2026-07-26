// @vitest-environment happy-dom
//
// Behavioral coverage for hydrate() (hydrate.ts): adopting real server-rendered
// markup (produced by azerothjs's renderToString) WITHOUT rebuilding it,
// attaching event listeners + reactive effects onto the existing nodes, adopting
// control-flow output, and falling back to a clean client render on a structural
// mismatch. Real SSR -> hydrate round-trip, no mocked markup.
import { describe, it, expect, vi } from 'vitest';
import { createSignal, h, hydrate, render, Show, For, renderToString } from 'azerothjs';

function ssrInto(component: () => HTMLElement): HTMLElement
{
    const html = renderToString(component);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

describe('hydrate - adoption', () =>
{
    it('adopts the existing server node instead of rebuilding it', () =>
    {
        const App = (): HTMLElement => h('button', {}, 'Click');
        const container = ssrInto(App);
        const serverButton = container.querySelector('button')!;

        hydrate(App, container);
        // The SAME element node is kept (adopted), not replaced.
        expect(container.querySelector('button')).toBe(serverButton);
        container.remove();
    });

    it('attaches an event listener onto the adopted node', () =>
    {
        const [count, setCount] = createSignal(0);
        const App = (): HTMLElement =>
            h('button', { onClick: () => setCount((c) => c + 1) }, () => `${ count() }`);
        const container = ssrInto(App);
        const serverButton = container.querySelector('button')!;
        expect(serverButton.textContent).toBe('0');

        hydrate(App, container);
        // Listener now live on the existing node.
        serverButton.click();
        expect(serverButton.textContent).toBe('1');
        container.remove();
    });

    it('wires a reactive text hole onto adopted markup with no first-run flash', () =>
    {
        const [name, setName] = createSignal('Ada');
        const App = (): HTMLElement => h('p', {}, () => name());
        const container = ssrInto(App);
        const serverP = container.querySelector('p')!;
        expect(serverP.textContent).toBe('Ada');

        hydrate(App, container);
        // Same element, same value (no flash on the first run).
        expect(container.querySelector('p')).toBe(serverP);
        expect(serverP.textContent).toBe('Ada');

        setName('Grace');
        expect(serverP.textContent).toBe('Grace');
        container.remove();
    });

    it('adopts a Show control-flow branch and keeps it reactive', () =>
    {
        const [on, setOn] = createSignal(true);
        const App = (): HTMLElement => h('div', {}, Show({
            when: on,
            fallback: () => h('span', { class: 'fb' }, 'off'),
            children: () => h('span', { class: 'main' }, 'on')
        }));
        const container = ssrInto(App);
        expect(container.querySelector('.main')).not.toBeNull();
        const serverSpan = container.querySelector('.main')!;

        hydrate(App, container);
        // Adopted, not rebuilt.
        expect(container.querySelector('.main')).toBe(serverSpan);

        // Toggling after hydration uses the normal DOM swap.
        setOn(false);
        expect(container.querySelector('.fb')).not.toBeNull();
        expect(container.querySelector('.main')).toBeNull();
        container.remove();
    });

    it('adopts For rows and keeps them keyed-reactive', () =>
    {
        const [items, setItems] = createSignal([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
        const App = (): HTMLElement => h('ul', {}, For({
            each: items,
            key: (r) => r.id,
            children: (r) => h('li', { 'data-id': String(r.id) }, r.name)
        }));
        const container = ssrInto(App);
        const serverRows = Array.from(container.querySelectorAll('li'));
        expect(serverRows.length).toBe(2);

        hydrate(App, container);
        const afterRows = Array.from(container.querySelectorAll('li'));
        // Rows adopted in place.
        expect(afterRows[0]).toBe(serverRows[0]);
        expect(afterRows[1]).toBe(serverRows[1]);

        // Appending reuses the adopted survivors.
        setItems([{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]);
        const finalRows = Array.from(container.querySelectorAll('li'));
        expect(finalRows[0]).toBe(serverRows[0]);
        expect(finalRows[1]).toBe(serverRows[1]);
        expect(finalRows[2]?.getAttribute('data-id')).toBe('3');
        container.remove();
    });
});

describe('hydrate - reactive element/list holes', () =>
{
    it('adopts a reactive hole that returns an ELEMENT (not [object Object])', () =>
    {
        const [on, setOn] = createSignal(true);
        const App = (): HTMLElement =>
            h('div', {}, () => (on() ? h('strong', {}, 'ON') : h('em', {}, 'OFF')));
        const container = ssrInto(App);
        const serverStrong = container.querySelector('strong')!;
        expect(serverStrong.textContent).toBe('ON');

        hydrate(App, container);
        // The server element is adopted in place - NOT stringified to "[object Object]".
        expect(container.textContent).not.toContain('[object Object]');
        expect(container.querySelector('strong')).toBe(serverStrong);

        // Reactive after hydration: the hole swaps element type on flip.
        setOn(false);
        expect(container.querySelector('strong')).toBeNull();
        expect(container.querySelector('em')!.textContent).toBe('OFF');
        container.remove();
    });

    it('adopts a reactive hole that returns a LIST of elements', () =>
    {
        const [items, setItems] = createSignal(['a', 'b', 'c']);
        const App = (): HTMLElement =>
            h('ul', {}, () => items().map((t) => h('li', {}, t)));
        const container = ssrInto(App);
        const serverRows = Array.from(container.querySelectorAll('li'));
        expect(serverRows.length).toBe(3);
        expect(container.textContent).not.toContain('[object Object]');

        hydrate(App, container);
        // Rows adopted in place, no corruption.
        expect(container.textContent).not.toContain('[object Object]');
        const afterRows = Array.from(container.querySelectorAll('li'));
        expect(afterRows[0]).toBe(serverRows[0]);
        expect(afterRows[2]).toBe(serverRows[2]);

        // Reactive after hydration.
        setItems(['x']);
        const finalRows = Array.from(container.querySelectorAll('li'));
        expect(finalRows.length).toBe(1);
        expect(finalRows[0]!.textContent).toBe('x');
        container.remove();
    });

    it('adopts a reactive hole mixing element and text children', () =>
    {
        const [n, setN] = createSignal(2);
        const App = (): HTMLElement =>
            h('p', {}, () => [h('b', {}, 'count:'), ` ${ n() }`]);
        const container = ssrInto(App);
        expect(container.textContent).not.toContain('[object Object]');
        expect(container.querySelector('b')!.textContent).toBe('count:');

        hydrate(App, container);
        expect(container.textContent).not.toContain('[object Object]');
        expect(container.textContent).toContain('count:');
        expect(container.textContent).toContain('2');

        setN(9);
        expect(container.textContent).toContain('9');
        container.remove();
    });
});

describe('hydrate - content props and implicit tbody (no false fallback)', () =>
{
    it('adopts an element rendered with innerHTML without a whole-page fallback', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        const App = (): HTMLElement => h('div', { id: 'ih', innerHTML: '<b>hi</b>' });
        const container = ssrInto(App);
        const serverDiv = container.querySelector('#ih')!;

        hydrate(App, container);
        expect(warn).not.toHaveBeenCalled(); // no mismatch fallback
        expect(container.querySelector('#ih')).toBe(serverDiv); // adopted in place
        expect(serverDiv.innerHTML).toBe('<b>hi</b>');
        warn.mockRestore();
        container.remove();
    });

    it('adopts an element rendered with textContent without a fallback', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        const App = (): HTMLElement => h('div', { textContent: 'plain' });
        const container = ssrInto(App);
        hydrate(App, container);
        expect(warn).not.toHaveBeenCalled();
        expect(container.querySelector('div')!.textContent).toBe('plain');
        warn.mockRestore();
        container.remove();
    });

    it('adopts a table whose <tr> rows the browser wrapped in an implicit <tbody>', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        const [cell, setCell] = createSignal('a');
        const App = (): HTMLElement =>
            h('table', {}, h('tr', {}, h('td', {}, () => cell()), h('td', {}, 'static')));
        const container = ssrInto(App);
        // happy-dom, like a real browser, inserts the implicit tbody on innerHTML parse.
        const serverCell = container.querySelector('td')!;

        hydrate(App, container);
        expect(warn).not.toHaveBeenCalled(); // implicit tbody tolerated, no fallback
        expect(container.querySelector('td')).toBe(serverCell); // row adopted in place

        setCell('CHANGED'); // reactivity wired onto the adopted cell
        expect(serverCell.textContent).toBe('CHANGED');
        warn.mockRestore();
        container.remove();
    });
});

describe('hydrate - mismatch fallback', () =>
{
    it('falls back to a clean client render when the client tree diverges structurally', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        // Server rendered a <p> with two children; client renders a single different child.
        const serverHtml = renderToString(() => h('section', {}, h('p', {}, 'a'), h('p', {}, 'b')));
        const container = document.createElement('div');
        container.innerHTML = serverHtml;
        document.body.appendChild(container);

        // Client component produces a structurally different tree (one child).
        const ClientApp = (): HTMLElement => h('section', {}, h('h1', {}, 'fresh'));
        hydrate(ClientApp, container);

        // Fallback render produced the client tree.
        expect(container.querySelector('h1')!.textContent).toBe('fresh');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        container.remove();
    });

    it('disposes a previous mount on the same container before hydrating', () =>
    {
        const [n, setN] = createSignal(0);
        const container = document.createElement('div');
        document.body.appendChild(container);
        // First a client render.
        render(() => h('span', {}, () => `${ n() }`), container);
        expect(container.textContent).toBe('0');

        // Then hydrate the same container against fresh SSR markup.
        const App = (): HTMLElement => h('span', {}, 'hydrated');
        container.innerHTML = renderToString(App);
        hydrate(App, container);
        expect(container.textContent).toBe('hydrated');

        // The old client mount's effect is gone: updating n does nothing.
        setN(5);
        expect(container.textContent).toBe('hydrated');
        container.remove();
    });
});
