import { describe, it, expect } from 'vitest';
import { createSignal, classList, styleMap } from '@azerothjs/core';
import { h } from '@azerothjs/renderer';
import { renderToStaticMarkup, renderToDocument } from '@azerothjs/server';

// Production XSS audit for the SSR path. The escaping rules themselves are
// covered by render-to-string.test.ts for static values; this suite hardens the
// DYNAMIC vectors - attacker-controlled signal values flowing through reactive
// attributes, reactive holes, and classList/styleMap - which must stay escaped
// after the getter-resolution fix (a getter is now called through to its
// concrete value, so its output must still be treated as untrusted text).

const BREAKOUT = '"><img src=x onerror=alert(1)>';

describe('SSR escaping of attacker-controlled DYNAMIC values', () =>
{
    it('escapes a reactive attribute value so it cannot break out of the attribute', () =>
    {
        const [title] = createSignal(BREAKOUT);
        const html = renderToStaticMarkup(() => h('div', { title: () => title() }));

        // The raw breakout sequence (quote + tag open) must never appear; the
        // payload survives only as inert escaped text inside the attribute.
        expect(html).not.toContain('"><img');
        expect(html).toContain('&quot;&gt;&lt;img');
        expect(html).toBe('<div title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></div>');
    });

    it('escapes a reactive text hole', () =>
    {
        const [name] = createSignal('<script>alert(1)</script>');
        const html = renderToStaticMarkup(() => h('p', {}, () => name()));

        expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });

    it('escapes a class produced by classList() from an attacker value', () =>
    {
        const [evil] = createSignal(BREAKOUT);
        // A dynamic class name (unusual, but possible) must be escaped, not
        // emitted raw, even though classList returns a getter.
        const html = renderToStaticMarkup(() =>
            h('div', { class: () => (classList({ [evil()]: true })) }));

        expect(html).not.toContain('"><img');
        expect(html).toContain('class="&quot;&gt;&lt;img');
    });

    it('escapes a style value produced by styleMap() from an attacker value', () =>
    {
        const [color] = createSignal(BREAKOUT);
        const html = renderToStaticMarkup(() =>
            h('div', { style: () => (styleMap({ color: () => color() })) }));

        expect(html).not.toContain('"><img');
        expect(html).toContain('&quot;&gt;&lt;img');
    });

    it('escapes the renderToDocument title', () =>
    {
        const html = renderToDocument(() => h('main', {}, 'ok'), { title: '</title><script>alert(1)</script>' });

        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
    });

    it('treats innerHTML as raw by design (documented trust boundary)', () =>
    {
        // innerHTML is the one deliberate escape hatch - identical trust model to
        // `el.innerHTML = x` on the client. Callers must sanitize. This test pins
        // the contract so the behavior is never changed silently.
        const html = renderToStaticMarkup(() => h('div', { innerHTML: '<b>raw</b>' }));
        expect(html).toBe('<div><b>raw</b></div>');
    });
});
