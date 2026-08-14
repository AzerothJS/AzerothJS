// @vitest-environment node
//
// Raw-text elements (`<script>`/`<style>`) must honour the content properties in string mode
// exactly as the DOM path does: `el.textContent = x` and `el.innerHTML = x` both set the
// element's raw content verbatim. Skipping them serializes an EMPTY element, which a crawler
// or any non-hydrating reader sees as a page with no JSON-LD/CSS at all - invisible in a
// browser, because hydration fills the content client-side.
//
// The content must NOT be entity-escaped (a browser never decodes entities inside raw-text
// elements), but it MUST be breakout-neutralized: a value containing the element's own end
// tag would otherwise terminate the element mid-content and everything after it would parse
// as live markup.
import { describe, expect, it } from 'vitest';

import { h, renderToString, unsafeTag } from '../../src/index.ts';

describe('script data blocks carry their textContent', () =>
{
    it('serializes JSON-LD passed through textContent', () =>
    {
        const data = { '@type': 'Article', name: 'A & B' };
        const html = renderToString(
            () => h('script', { type: 'application/ld+json', textContent: JSON.stringify(data) }),
            { markers: false });

        // Verbatim: the & and the quotes stay literal, exactly as the DOM property sets them.
        expect(html).toBe('<script type="application/ld+json">{"@type":"Article","name":"A & B"}</script>');
    });

    it('neutralizes a breakout attempt inside textContent', () =>
    {
        const hostile = JSON.stringify({ x: '</script><img src=x onerror=alert(1)>' });
        const html = renderToString(
            () => h('script', { type: 'application/ld+json', textContent: hostile }),
            { markers: false });

        // The close-tag sequence cannot survive into raw code position...
        expect(html).not.toContain('</script><img');
        // ...it becomes the lossless JS escape, still `<` after JSON.parse.
        expect(html).toContain('\\u003c/script');
        expect(html.endsWith('</script>')).toBe(true);
    });

    it('serializes an executable script body through unsafeTag + textContent', () =>
    {
        const html = renderToString(
            () => h(unsafeTag('script'), { textContent: 'console.log(1 && 2)' }),
            { markers: false });

        expect(html).toBe('<script>console.log(1 && 2)</script>');
    });

    it('innerHTML wins over textContent, matching the documented precedence', () =>
    {
        const html = renderToString(
            () => h('script', { type: 'application/ld+json', innerHTML: '{"a":1}', textContent: '{"b":2}' }),
            { markers: false });

        expect(html).toBe('<script type="application/ld+json">{"a":1}</script>');
    });
});

describe('style elements carry their content properties', () =>
{
    it('serializes CSS passed through innerHTML without entity-escaping', () =>
    {
        const html = renderToString(
            () => h('style', { innerHTML: '.a > .b { color: red; }' }),
            { markers: false });

        expect(html).toBe('<style>.a > .b { color: red; }</style>');
    });

    it('neutralizes a close-tag attempt inside style textContent', () =>
    {
        const html = renderToString(
            () => h('style', { textContent: '.x::after { content: "</style><b>pwn</b>"; }' }),
            { markers: false });

        expect(html).not.toContain('</style><b>');
        // The CSS hex escape decodes back to `<` inside a CSS string.
        expect(html).toContain('\\3c/style');
        expect(html.endsWith('</style>')).toBe(true);
    });
});
