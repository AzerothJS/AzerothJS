// @vitest-environment happy-dom
//
// The FRAGMENT ROOT, across all three modes.
//
// `<>...</>` is normative grammar (GRAMMAR.md 6) and the compiler's own multiple-root diagnostic
// tells authors to wrap sibling roots in one. Both compiler backends emit a fragment as a JS
// ARRAY, and static text inside it as a plain STRING - `<> hello <b>x</b> </>` compiles to
// `[' hello ', h('b', {}, 'x')]`.
//
// The renderer has ONE routine per side for resolving a child of any shape: appendChild on the
// mount side and hydrateChild on the adopt side. Every non-root child goes through them. The three
// mount paths - render, hydrate and renderTest - each re-implemented a narrower subset for the
// ROOT only, and the subsets were wrong in different ways: render crashed on the string, hydrate
// rejected the array as unhydratable and silently fell back to a FULL CLIENT RENDER (the warning
// is DEV-only), and renderTest could not take the array at all.
//
// These arms pin the root going through the shared routines, which is what makes the three modes
// agree by construction (invariant 2) rather than by coincidence.
import { describe, it, expect } from 'vitest';
import { h, hydrate, render, renderToString } from 'azerothjs';
import type { MountNode } from 'azerothjs';

// Exactly what the compiler emits for `<> hello <b>x</b> </>`: a STRING beside an element.
const textFragment = (): (string | HTMLElement)[] => [' hello ', h('b', {}, 'x')];

// The report's shape: sibling roots, no bare text.
const elementFragment = (): HTMLElement[] => [h('a', { href: '#main' }, 'skip'), h('main', {}, 'hi')];

const singleRoot = (): HTMLElement => h('main', {}, h('span', {}, 'hi'));

function ssrInto(component: () => MountNode): HTMLElement
{
    const container = document.createElement('div');
    container.innerHTML = renderToString(component);
    document.body.appendChild(container);
    return container;
}

describe('a fragment-rooted component mounts', () =>
{
    it('renders a fragment whose children include static TEXT', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(textFragment, container);
        expect(container.innerHTML).toBe(' hello <b>x</b>');
        container.remove();
    });

    it('renders a fragment of sibling ELEMENTS as direct children, with no wrapper', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(elementFragment, container);
        expect(container.innerHTML).toBe('<a href="#main">skip</a><main>hi</main>');
        expect(container.children.length).toBe(2);
        container.remove();
    });

    it('CONTROL: a single-element root still mounts unchanged', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(singleRoot, container);
        expect(container.innerHTML).toBe('<main><span>hi</span></main>');
        container.remove();
    });
});

describe('a fragment-rooted component hydrates', () =>
{
    it('ADOPTS the server nodes instead of rebuilding them', () =>
    {
        const container = ssrInto(elementFragment);
        const serverLink = container.querySelector('a')!;
        const serverMain = container.querySelector('main')!;

        hydrate(elementFragment, container);

        // The SAME nodes survive. Before, the array root failed the hydratable-root test and the
        // pass fell back to a full client render, replacing both - silently in production.
        expect(container.querySelector('a')).toBe(serverLink);
        expect(container.querySelector('main')).toBe(serverMain);
        container.remove();
    });

    it('adopts a fragment carrying static TEXT beside an element', () =>
    {
        const container = ssrInto(textFragment);
        const serverBold = container.querySelector('b')!;

        hydrate(textFragment, container);

        expect(container.querySelector('b')).toBe(serverBold);
        expect(container.innerHTML).toBe(' hello <b>x</b>');
        container.remove();
    });

    it('CONTROL: a single-element root still adopts', () =>
    {
        const container = ssrInto(singleRoot);
        const serverMain = container.querySelector('main')!;
        hydrate(singleRoot, container);
        expect(container.querySelector('main')).toBe(serverMain);
        container.remove();
    });
});

describe('the three modes agree on a fragment root', () =>
{
    it('SSR, client render and hydration produce identical markup', () =>
    {
        const ssr = renderToString(textFragment);

        const clientContainer = document.createElement('div');
        document.body.appendChild(clientContainer);
        render(textFragment, clientContainer);

        const hydrated = ssrInto(textFragment);
        hydrate(textFragment, hydrated);

        expect(clientContainer.innerHTML).toBe(ssr);
        expect(hydrated.innerHTML).toBe(ssr);
        clientContainer.remove();
        hydrated.remove();
    });
});
