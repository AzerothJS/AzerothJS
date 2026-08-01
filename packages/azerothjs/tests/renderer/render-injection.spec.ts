// @vitest-environment node
//
// The render-safety gate decides what a value is ALLOWED to become in the output. These specs
// pin two attacker vectors through it, verified differentially against react-dom/server and
// confirmed to execute in real Chromium.
//
// 1. `assertSafeTag` must vet the tag against the HTML name production, not just a refused-name
//    SET, because `serializeElement` interpolates the name raw. A tag of
//    `img src=x onerror=alert(1)` is not a refused name; written verbatim, the browser parses
//    the attributes out of it. `document.createElement` rejects that name, so a set-only check
//    fails safe in the DOM and injects only on SSR - the exact server/client split the gate
//    exists to prevent.
//
// 2. `assertSafeUrl` must gate every carrier, not `typeof candidate === 'string'`, because both
//    writers coerce with `String(value)`. Any carrier whose string form is a dangerous URL walks
//    past a string-only check: an array is the realistic one, since a repeated query parameter
//    (`?next=javascript:...&next=x`) yields an array from every mainstream parser.
//
// The rule both checks encode: gate the value that will actually be WRITTEN, not the value's
// declared type.
import { describe, expect, it, vi } from 'vitest';

import { h, unsafeTag, unsafeUrl, renderToString } from '../../src/index.ts';

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
        expect(() => renderToString(() => h(tag, {}, 'inner'), { markers: false })).toThrow(/azeroth/);
    });

    it.each(['div', 'span', 'my-element', 'foreignObject', 'clipPath', 'linearGradient', 'h1', 'a'])('still renders the legal name %j', (tag) =>
    {
        expect(() => renderToString(() => h(tag, {}, 'x'), { markers: false })).not.toThrow();
    });

    it('refuses a hostile name even through unsafeTag, which exists to allow refused TAGS not arbitrary markup', () =>
    {
        expect(() => renderToString(() => h(unsafeTag('img src=x onerror=alert(1)'), {}, 'i'), { markers: false })).toThrow(/azeroth/);
        // The escape hatch keeps working for what it is actually for.
        expect(renderToString(() => h(unsafeTag('base'), { href: '/x' }), { markers: false })).toContain('<base');
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
            expect(() => renderToString(() => h('a', { [attribute]: make() }), { markers: false })).toThrow(/azeroth/);
        });
    }

    it.each([
        ['vbscript, as a string', 'vbscript:msgbox(1)'],
        ['vbscript, in an array', ['vbscript:msgbox(1)']],
        ['a data: document, as a string', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
        ['a data: document, in an array', ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']]
    ])('refuses %s', (_label, value) =>
    {
        expect(() => renderToString(() => h('a', { href: value }), { markers: false })).toThrow(/azeroth/);
    });

    it('leaves ordinary values alone', () =>
    {
        expect(renderToString(() => h('a', { href: '/safe' }), { markers: false })).toBe('<a href="/safe"></a>');
        expect(renderToString(() => h('a', { href: ['/a', '/b'] }), { markers: false })).toBe('<a href="/a,/b"></a>');
        expect(renderToString(() => h('img', { src: 'https://example.com/x.png' }), { markers: false })).toContain('x.png');
    });

    it('still honours the unsafeUrl opt-out', () =>
    {
        expect(renderToString(() => h('a', { href: unsafeUrl('javascript:alert(1)') }), { markers: false })).toContain('javascript:alert(1)');
    });
});

describe('an attribute name cannot carry a delimiter into the tag', () =>
{
    it.each(['a<b', 'a`b', 'a>b', 'a=b', 'a b', 'a"b', "a'b", 'a/b'])('refuses %j', (name) =>
    {
        expect(() => renderToString(() => h('div', { [name]: 'v' }), { markers: false })).toThrow(/azeroth/);
    });

    it.each(['data-x', 'aria-label', 'id', 'xlink:href', 'my_attr', 'a.b'])('still allows %j', (name) =>
    {
        expect(() => renderToString(() => h('div', { [name]: 'v' }), { markers: false })).not.toThrow();
    });
});

describe('an on* prop is recognised regardless of case', () =>
{
    it.each(['onclick', 'onClick', 'ONCLICK', 'OnClick', 'oNcLiCk'])('does not invoke the %s handler while rendering', (key) =>
    {
        const handler = vi.fn(() => 'SIDE EFFECT RAN');

        const html = renderToString(() => h('div', { [key]: handler }, 'x'), { markers: false });

        expect(handler).not.toHaveBeenCalled();
        expect(html).toBe('<div>x</div>');
    });
});
