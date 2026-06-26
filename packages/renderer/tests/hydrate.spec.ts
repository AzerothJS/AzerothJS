// @vitest-environment happy-dom
//
// Behavioral coverage for hydrate() (hydrate.ts): adopting real server-rendered
// markup (produced by @azerothjs/server's renderToString) WITHOUT rebuilding it,
// attaching event listeners + reactive effects onto the existing nodes, adopting
// control-flow output, and falling back to a clean client render on a structural
// mismatch. Real SSR -> hydrate round-trip, no mocked markup.
import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, hydrate, render, Show, For } from '@azerothjs/renderer';
import { renderToString } from '@azerothjs/server';

function ssrInto(component: () => HTMLElement): HTMLElement
{
    const html = renderToString(component);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

describe('hydrate — adoption', () =>
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
        expect(finalRows[2].getAttribute('data-id')).toBe('3');
        container.remove();
    });
});

describe('hydrate — mismatch fallback', () =>
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
