// @vitest-environment node
//
// Regression: hole anchors inside <textarea> or <title> are served as visible text, and a
// textarea's value written as an attribute serves an empty field.
import { describe, expect, it } from 'vitest';

import { createSignal, h, renderToString, renderToStream, ssr } from '../../src/index.ts';
import type { Child } from '../../src/index.ts';

async function streamed(view: () => HTMLElement): Promise<string>
{
    const reader = renderToStream(view).getReader();
    const decoder = new TextDecoder();
    let html = '';
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            return html;
        }
        html += decoder.decode(value, { stream: true });
    }
}

const quiet = (view: () => HTMLElement): string => renderToString(view, { markers: false });

describe('textarea and title content is one escaped text', () =>
{
    it('joins text and holes with no anchors, markers on or off and streamed, while <i> keeps them', async () =>
    {
        const [v] = createSignal('hi');
        const view = (): HTMLElement => h('div', {},
            h('textarea', { name: 't' }, 'Hello ', () => v()),
            h('title', {}, () => v(), ' - Site'),
            h('i', {}, 'Hello ', () => v()));
        const marked = renderToString(view);

        expect(marked).toBe('<div><textarea name="t">Hello hi</textarea><title>hi - Site</title><i>Hello <!--[-->hi<!--]--></i></div>');
        expect(quiet(view)).toBe('<div><textarea name="t">Hello hi</textarea><title>hi - Site</title><i>Hello hi</i></div>');
        expect(await streamed(view)).toBe(marked);
    });

    it('gives each hole the text the same hole gives inside <i> (control)', () =>
    {
        const holes = (): Child[] => [null, undefined, false, '|', () => true, '|', 0, '|', Number.NaN, '|', ['a', ['b', () => 'c']], '|', () => () => 'd', '|', () => ({})];

        expect(quiet(() => h('title', {}, ...holes()))).toBe('<title>|true|0|NaN|abc|d|[object Object]</title>');
        expect(quiet(() => h('i', {}, ...holes()))).toBe('<i>|true|0|NaN|abc|d|[object Object]</i>');
    });

    it('escapes the text, so it can neither close the element nor open a comment (control)', () =>
    {
        expect(quiet(() => h('title', {}, () => '</title><b>x</b> & <!--c-->')))
            .toBe('<title>&lt;/title&gt;&lt;b&gt;x&lt;/b&gt; &amp; &lt;!--c--&gt;</title>');
    });

    it('pads escaped textarea text that starts with a reference, whose extra line feed the parser drops', () =>
    {
        expect(quiet(() => h('textarea', {}, () => '</textarea> & <!--c-->')))
            .toBe('<textarea>\n&lt;/textarea&gt; &amp; &lt;!--c--&gt;</textarea>');
    });

    it('refuses an element or a component output inside, in string mode', () =>
    {
        expect(() => renderToString(() => h('textarea', {}, h('b', {}, 'x'))))
            .toThrow(/A hole inside <textarea> gives text/);
        expect(() => renderToString(() => h('title', {}, () => ssr('<b>x</b>'))))
            .toThrow(/A hole inside <title> gives text/);
    });

    it('adds the line feed the parser drops after <textarea>, for LF, CR and a reference', () =>
    {
        expect(quiet(() => h('textarea', {}, '\nx'))).toBe('<textarea>\n\nx</textarea>');
        // A CR is written as a reference, so the pad keys on its `&`.
        expect(quiet(() => h('textarea', {}, '\rx'))).toBe('<textarea>\n&#13;x</textarea>');
        expect(quiet(() => h('textarea', { value: '\nx' }))).toBe('<textarea>\n\nx</textarea>');
        expect(quiet(() => h('textarea', { innerHTML: '&#10;x' }))).toBe('<textarea>\n&#10;x</textarea>');
        expect(quiet(() => h('textarea', {}, 'x\n'))).toBe('<textarea>x\n</textarea>');
        expect(quiet(() => h('title', {}, '\nx'))).toBe('<title>\nx</title>');
    });

    it('keeps innerHTML inside its element', () =>
    {
        expect(quiet(() => h('textarea', { innerHTML: 'a &amp; b</TEXTAREA ><i id="leak">x</i>' })))
            .toBe('<textarea>a &amp; b&lt;/TEXTAREA ><i id="leak">x</i></textarea>');
        expect(quiet(() => h('title', { innerHTML: 'a</title><i>x</i>' })))
            .toBe('<title>a&lt;/title><i>x</i></title>');
    });
});

describe('a CR in textarea or title text', () =>
{
    it('is written as a reference from children, a hole, a value and textContent, markers on or off and streamed', async () =>
    {
        expect(quiet(() => h('textarea', {}, 'a\rb'))).toBe('<textarea>a&#13;b</textarea>');
        expect(quiet(() => h('textarea', {}, () => 'a\r\nb'))).toBe('<textarea>a&#13;\nb</textarea>');
        expect(quiet(() => h('textarea', { value: 'a\r\nb' }))).toBe('<textarea>a&#13;\nb</textarea>');
        expect(quiet(() => h('textarea', { textContent: 'a\r\nb' }))).toBe('<textarea>a&#13;\nb</textarea>');
        expect(quiet(() => h('title', {}, () => 'a\rb'))).toBe('<title>a&#13;b</title>');
        const view = (): HTMLElement => h('div', {}, h('textarea', {}, 'x\r', () => 'y'), h('title', {}, () => '\rz'));
        expect(renderToString(view)).toBe('<div><textarea>x&#13;y</textarea><title>&#13;z</title></div>');
        expect(await streamed(view)).toBe(renderToString(view));
    });

    it('stays raw in innerHTML and in every other element (control)', () =>
    {
        expect(quiet(() => h('textarea', { innerHTML: 'a\rb' }))).toBe('<textarea>a\rb</textarea>');
        expect(quiet(() => h('pre', {}, 'a\rb'))).toBe('<pre>a\rb</pre>');
    });
});

describe('a textarea value is its text', () =>
{
    it('serves the value as escaped text and drops the attribute', () =>
    {
        const [v] = createSignal('a<b & "c"');

        expect(quiet(() => h('textarea', { name: 't', value: () => v() }))).toBe('<textarea name="t">a&lt;b &amp; "c"</textarea>');
    });

    it('coerces the value as the value property does', () =>
    {
        const text = (value: unknown): string => quiet(() => h('textarea', { value }));

        expect(text(null)).toBe('<textarea></textarea>');
        expect(text(undefined)).toBe('<textarea>undefined</textarea>');
        expect(text(false)).toBe('<textarea>false</textarea>');
        expect(text(0)).toBe('<textarea>0</textarea>');
        expect(text(['a', 'b'])).toBe('<textarea>a,b</textarea>');
    });

    it('serves the value over children', () =>
    {
        const [w] = createSignal('kid');

        expect(quiet(() => h('textarea', { value: 'a' }, 'child'))).toBe('<textarea>a</textarea>');
        expect(quiet(() => h('textarea', { ...{ value: () => 'b' } }, 'Kid ', () => w()))).toBe('<textarea>b</textarea>');
    });

    it('refuses value beside textContent or innerHTML in string mode', () =>
    {
        expect(() => renderToString(() => h('textarea', { value: 'a', textContent: 'b' })))
            .toThrow(/'value' and 'textContent' both set a <textarea>'s text/);
        expect(() => renderToString(() => h('textarea', { innerHTML: 'b', value: 'a' })))
            .toThrow(/'value' and 'innerHTML' both set a <textarea>'s text/);
    });

    it('keeps value an attribute on input and leaves select to its options (control)', () =>
    {
        expect(quiet(() => h('input', { value: 'hi' }))).toBe('<input value="hi">');
        expect(quiet(() => h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'))))
            .toBe('<select><option value="a">A</option><option value="b" selected="">B</option></select>');
    });
});

describe('a mixed-case host tag', () =>
{
    const [v] = createSignal('hi');
    const lower = (): HTMLElement => h('div', {}, h('textarea', {}, 'Hello ', () => v()), h('title', {}, () => v(), ' - Site'));
    const mixed = (): HTMLElement => h('div', {}, h('textArea', {}, 'Hello ', () => v()), h('tiTle', {}, () => v(), ' - Site'));

    it('joins the text of a textArea and a tiTle with no anchors', () =>
    {
        expect(renderToString(mixed)).toBe('<div><textarea>Hello hi</textarea><title>hi - Site</title></div>');
    });

    it('serves textArea and tiTle like their lowercase twins (control)', () =>
    {
        expect(renderToString(mixed)).toBe(renderToString(lower));
    });
});

describe('noscript content is served (control)', () =>
{
    it('serializes its markup for a reader without scripting', () =>
    {
        const [v] = createSignal('hi');

        expect(renderToString(() => h('noscript', {}, h('p', {}, 'Hello ', () => v())))).toBe('<noscript><p>Hello <!--[-->hi<!--]--></p></noscript>');
    });
});
