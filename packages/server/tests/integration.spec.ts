// @vitest-environment happy-dom
//
// Cross-module integration for the SSR package: the SSR string output must match what the DOM
// renderer builds (parity), and a server-rendered page must hydrate IN PLACE - adopting the
// existing nodes (node identity preserved) and then driving reactive updates and event handlers
// without a re-render. A DOM is required to hydrate into, so this file uses the default
// happy-dom environment.
//
// No mocks: real signals/effects, the real string emitter, the real DOM renderer, and the real
// hydrate() walking real happy-dom nodes.
import { describe, it, expect } from 'vitest';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';
import { h, render, hydrate, Show, For } from '@azerothjs/renderer';
import { createSignal } from '@azerothjs/reactivity';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('SSR <-> CSR parity', () =>
{
    it('static markup of a plain tree matches what the DOM renderer builds', () =>
    {
        const build = (): HTMLElement =>
            h('section', { id: 'root', class: 'card' },
                h('h1', {}, 'Title'),
                h('p', {}, 'Body text & more'));

        const ssrHtml = renderToStaticMarkup(build);
        const container = mount(build);

        expect(ssrHtml).toBe(container.innerHTML);
        // Sanity: the text content the user sees is identical too.
        expect(container.textContent).toBe('TitleBody text & more');
        container.remove();
    });

    it('a resolved reactive hole matches the DOM text (markers stripped)', () =>
    {
        const [name] = createSignal('Ada');
        const build = (): HTMLElement => h('span', {}, () => `Hello ${ name() }`);

        const ssrStatic = renderToStaticMarkup(build);
        const container = mount(build);

        // The DOM renderer drives the hole into a bare text node; static SSR matches it exactly.
        expect(ssrStatic).toBe('<span>Hello Ada</span>');
        expect(container.innerHTML).toBe('<span>Hello Ada</span>');
        container.remove();
    });

    it('Show renders the same active branch in SSR (markers off) and the DOM', () =>
    {
        const build = (): HTMLElement =>
            h('div', {}, Show({
                when: true,
                fallback: () => h('em', {}, 'off'),
                children: () => h('strong', {}, 'on')
            }));

        const ssrStatic = renderToStaticMarkup(build);
        const container = mount(build);

        expect(ssrStatic).toBe('<div><strong>on</strong></div>');
        // The DOM path brackets the branch with comment markers, but the VISIBLE markup
        // (elements + text) matches the marker-free SSR output.
        expect(container.textContent).toBe('on');
        expect(container.querySelector('strong')?.textContent).toBe('on');
        container.remove();
    });

    it('For renders the same rows in SSR and the DOM', () =>
    {
        const build = (): HTMLElement =>
            h('ul', {}, For({
                each: ['a', 'b', 'c'],
                key: (i) => i,
                children: (item) => h('li', {}, item)
            }));

        const ssrStatic = renderToStaticMarkup(build);
        const container = mount(build);

        expect(ssrStatic).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
        expect([...container.querySelectorAll('li')].map((li) => li.textContent))
            .toEqual(['a', 'b', 'c']);
        container.remove();
    });
});

describe('SSR -> hydrate -> interact round trip', () =>
{
    it('adopts server nodes IN PLACE (node identity preserved) and updates reactively', () =>
    {
        const [count, setCount] = createSignal(0);
        const App = (): HTMLElement =>
            h('div', { id: 'app' },
                h('h1', {}, 'Counter'),
                h('button', { onClick: () => setCount((c) => c + 1) }, () => `count: ${ count() }`));

        // 1. Server render with hydration markers.
        const serverHtml = renderToString(App);
        expect(serverHtml).toContain('<!--[-->count: 0<!--]-->');

        // 2. Place the server markup into a real container (as the browser would receive it).
        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = serverHtml;

        // Capture references to the EXACT server-rendered nodes before hydration.
        const serverDiv = container.querySelector('#app')!;
        const serverButton = container.querySelector('button')!;
        const serverH1 = container.querySelector('h1')!;
        expect(serverButton.textContent).toBe('count: 0');

        // 3. Hydrate: adopt the existing DOM, attach the listener + the reactive effect.
        hydrate(App, container);

        // Node identity is preserved - hydration adopted the server nodes rather than
        // replacing them (a mismatch would have fallen back to render() and swapped them out).
        expect(container.querySelector('#app')).toBe(serverDiv);
        expect(container.querySelector('button')).toBe(serverButton);
        expect(container.querySelector('h1')).toBe(serverH1);

        // 4. The reactive hole still shows the server value (no flash on first run).
        expect(serverButton.textContent).toBe('count: 0');

        // 5. A click drives the signal and patches the SAME button's text in place.
        serverButton.click();
        expect(serverButton.textContent).toBe('count: 1');
        serverButton.click();
        expect(serverButton.textContent).toBe('count: 2');
        // Still the same element instance - surgical in-place update, no re-render.
        expect(container.querySelector('button')).toBe(serverButton);

        container.remove();
    });

    it('hydrates a Show co-range and toggles its branch reactively post-hydrate', () =>
    {
        const [open, setOpen] = createSignal(true);
        const App = (): HTMLElement =>
            h('div', {}, Show({
                when: open,
                fallback: () => h('p', { id: 'closed' }, 'Closed'),
                children: () => h('p', { id: 'open' }, 'Open')
            }));

        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = renderToString(App);

        const serverOpen = container.querySelector('#open')!;
        expect(serverOpen).not.toBeNull();

        hydrate(App, container);

        // Adopted in place - same node after hydration.
        expect(container.querySelector('#open')).toBe(serverOpen);

        // Toggling the condition swaps the branch on the client.
        setOpen(false);
        expect(container.querySelector('#open')).toBeNull();
        expect(container.querySelector('#closed')?.textContent).toBe('Closed');

        setOpen(true);
        expect(container.querySelector('#open')?.textContent).toBe('Open');

        container.remove();
    });

    it('hydrates a For list and reconciles it reactively, reusing surviving rows', () =>
    {
        const [items, setItems] = createSignal(['a', 'b', 'c']);
        const App = (): HTMLElement =>
            h('ul', {}, For({
                each: items,
                key: (i) => i,
                children: (item) => h('li', {}, item)
            }));

        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = renderToString(App);

        const serverFirst = container.querySelector('li')!;
        expect(serverFirst.textContent).toBe('a');

        hydrate(App, container);

        // The first row was adopted, not rebuilt.
        const rowA = [...container.querySelectorAll('li')].find((li) => li.textContent === 'a')!;
        expect(rowA).toBe(serverFirst);

        // Remove the middle item: 'a' and 'c' rows survive (same instances), 'b' is removed.
        setItems(['a', 'c']);
        expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a', 'c']);
        expect([...container.querySelectorAll('li')].find((li) => li.textContent === 'a')).toBe(rowA);

        container.remove();
    });

    it('escaped server output round-trips to the correct live text (no double escaping)', () =>
    {
        const [text] = createSignal('a < b & c');
        const App = (): HTMLElement => h('p', {}, () => text());

        const serverHtml = renderToString(App);
        // The server escaped the value.
        expect(serverHtml).toBe('<p><!--[-->a &lt; b &amp; c<!--]--></p>');

        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = serverHtml;

        // The browser parsed the entities back to the original text.
        const p = container.querySelector('p')!;
        expect(p.textContent).toBe('a < b & c');

        // Hydration adopts without changing that text (value matches -> no mutation).
        hydrate(App, container);
        expect(container.querySelector('p')).toBe(p);
        expect(p.textContent).toBe('a < b & c');

        container.remove();
    });
});
