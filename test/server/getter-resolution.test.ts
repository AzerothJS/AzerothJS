import { describe, it, expect } from 'vitest';
import { createSignal, classList, styleMap } from '@azerothjs/core';
import { h } from '@azerothjs/renderer';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';

// Server-side parity for the getter double-wrap fix (see the renderer's
// test/renderer/getter-resolution.test.ts). The SSR path must resolve a
// getter-returning-a-getter exactly like the DOM path, or `classList`/
// `styleMap` props and nested-getter holes would serialize the inner
// function's source into the HTML - and hydration would then mismatch.

describe('SSR resolves through nested getters', () =>
{
    it('serializes `class={classList(...)}` (compiler emits `() => (classList(...))`)', () =>
    {
        const [isActive] = createSignal(true);
        const html = renderToStaticMarkup(() =>
            h('div', { class: () => (classList({ 'btn': true, 'btn-active': isActive })) }));

        expect(html).toBe('<div class="btn btn-active"></div>');
    });

    it('serializes `style={styleMap(...)}` (compiler emits `() => (styleMap(...))`)', () =>
    {
        const html = renderToStaticMarkup(() =>
            h('div', { style: () => (styleMap({ color: 'red', 'font-weight': 'bold' })) }));

        expect(html).toBe('<div style="color: red; font-weight: bold"></div>');
    });

    it('serializes a getter-returning-a-getter child as text, not function source', () =>
    {
        const title = (): string => 'Hello';
        const html = renderToStaticMarkup(() => h('h1', {}, () => (title)));

        expect(html).toBe('<h1>Hello</h1>');
    });

    it('wraps a nested-getter hole in a SINGLE anchor pair (markers on)', () =>
    {
        const title = (): string => 'Hi';
        const html = renderToString(() => h('h1', {}, () => (title)));

        // Exactly one pair of reactive-hole anchors, matching what the client
        // hydrator adopts - not one pair per getter level.
        expect(html).toBe('<h1><!--[-->Hi<!--]--></h1>');
    });
});
