// @vitest-environment node
//
// The render-safety gate decides what a value is ALLOWED to become in the output. Two holes let
// attacker data through it, both found by differential testing against react-dom/server and both
// confirmed to execute in real Chromium.
//
// 1. `assertSafeTag` vetted the tag against a refused-name SET but never against the HTML name
//    production, and `serializeElement` interpolates the name raw. A tag of
//    `img src=x onerror=alert(1)` is not a refused name, so it was written verbatim and the
//    browser parsed the attributes out of it. `document.createElement` rejects that name, so the
//    DOM path failed safe and only SSR injected - the exact server/client split the gate exists
//    to prevent.
//
// 2. `assertSafeUrl` tested `typeof candidate === 'string'` while both writers coerce with
//    `String(value)`. Any carrier whose string form is a dangerous URL walked past: an array is
//    the realistic one, since a repeated query parameter (`?next=javascript:...&next=x`) yields
//    an array from every mainstream parser. The string form THREW, so the intent was never in
//    doubt - only the reach of the test.
//
// The rule both fixes encode: gate the value that will actually be WRITTEN, not the value's
// declared type.
import { describe, expect, it, vi } from 'vitest';

import { h, renderToStaticMarkup, unsafeTag, unsafeUrl } from '../../src/index.ts';

describe('the tag name is validated, not just checked against a refused set', () =>
{
    it.each([
        'img src=x onerror=alert(1)',
        'div onload=alert(1)',
        'a href=javascript:alert(1)',
        'div id="a"',
        'x<y',
        'a b',
        'div>',
        'div/',
        ' div',
        'div ',
        '',
        '<'
    ])('refuses %j', (tag) =>
    {
        expect(() => renderToStaticMarkup(() => h(tag, {}, 'inner'))).toThrow(/azeroth/);
    });

    it.each(['div', 'span', 'my-element', 'foreignObject', 'clipPath', 'linearGradient', 'h1', 'a'])('still renders the legal name %j', (tag) =>
    {
        expect(() => renderToStaticMarkup(() => h(tag, {}, 'x'))).not.toThrow();
    });

    it('refuses a hostile name even through unsafeTag, which exists to allow refused TAGS not arbitrary markup', () =>
    {
        expect(() => renderToStaticMarkup(() => h(unsafeTag('img src=x onerror=alert(1)'), {}, 'i'))).toThrow(/azeroth/);
        // The escape hatch keeps working for what it is actually for.
        expect(renderToStaticMarkup(() => h(unsafeTag('base'), { href: '/x' }))).toContain('<base');
    });
});

describe('the URL gate judges the value that gets written', () =>
{
    const carriers: ReadonlyArray<readonly [string, () => unknown]> = [
        ['a string', () => 'javascript:alert(1)'],
        ['a one-element array', () => ['javascript:alert(1)']],
        ['a String object', () => new String('javascript:alert(1)')],
        ['an object with toString', () => ({ toString: () => 'javascript:alert(1)' })],
        ['a thunk returning an array', () => () => ['javascript:alert(1)']]
    ];

    for (const attribute of ['href', 'src', 'action', 'formaction', 'poster', 'data'])
    {
        it.each(carriers)(`refuses ${ attribute } carrying %s`, (_label, make) =>
        {
            expect(() => renderToStaticMarkup(() => h('a', { [attribute]: make() }))).toThrow(/azeroth/);
        });
    }

    it.each([
        ['vbscript, as a string', 'vbscript:msgbox(1)'],
        ['vbscript, in an array', ['vbscript:msgbox(1)']],
        ['a data: document, as a string', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
        ['a data: document, in an array', ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']]
    ])('refuses %s', (_label, value) =>
    {
        expect(() => renderToStaticMarkup(() => h('a', { href: value }))).toThrow(/azeroth/);
    });

    it('leaves ordinary values alone', () =>
    {
        expect(renderToStaticMarkup(() => h('a', { href: '/safe' }))).toBe('<a href="/safe"></a>');
        expect(renderToStaticMarkup(() => h('a', { href: ['/a', '/b'] }))).toBe('<a href="/a,/b"></a>');
        expect(renderToStaticMarkup(() => h('img', { src: 'https://example.com/x.png' }))).toContain('x.png');
    });

    it('still honours the unsafeUrl opt-out', () =>
    {
        expect(renderToStaticMarkup(() => h('a', { href: unsafeUrl('javascript:alert(1)') }))).toContain('javascript:alert(1)');
    });
});

describe('an attribute name cannot carry a delimiter into the tag', () =>
{
    it.each(['a<b', 'a`b', 'a>b', 'a=b', 'a b', 'a"b', "a'b", 'a/b'])('refuses %j', (name) =>
    {
        expect(() => renderToStaticMarkup(() => h('div', { [name]: 'v' }))).toThrow(/azeroth/);
    });

    it.each(['data-x', 'aria-label', 'id', 'xlink:href', 'my_attr', 'a.b'])('still allows %j', (name) =>
    {
        expect(() => renderToStaticMarkup(() => h('div', { [name]: 'v' }))).not.toThrow();
    });
});

describe('an on* prop is recognised regardless of case', () =>
{
    it.each(['onclick', 'onClick', 'ONCLICK', 'OnClick', 'oNcLiCk'])('does not invoke the %s handler while rendering', (key) =>
    {
        const handler = vi.fn(() => 'SIDE EFFECT RAN');

        const html = renderToStaticMarkup(() => h('div', { [key]: handler }, 'x'));

        expect(handler).not.toHaveBeenCalled();
        expect(html).toBe('<div>x</div>');
    });
});
