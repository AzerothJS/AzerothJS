import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h } from '@azerothjs/renderer';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';

describe('renderToString - elements', () =>
{
    it('serializes a basic element with text', () =>
    {
        expect(renderToString(() => h('div', {}, 'Hello'))).toBe('<div>Hello</div>');
    });

    it('lowercases the tag name', () =>
    {
        expect(renderToString(() => h('DIV', {}, 'x'))).toBe('<div>x</div>');
    });

    it('escapes text content', () =>
    {
        expect(renderToString(() => h('div', {}, '<script>&"'))).toBe('<div>&lt;script&gt;&amp;"</div>');
    });

    it('nests elements', () =>
    {
        const html = renderToString(() => h('div', { class: 'card' }, h('h1', {}, 'T'), h('p', {}, 'D')));
        expect(html).toBe('<div class="card"><h1>T</h1><p>D</p></div>');
    });

    it('flattens array children', () =>
    {
        const html = renderToString(() => h('ul', {}, ['a', 'b'].map((x) => h('li', {}, x))));
        expect(html).toBe('<ul><li>a</li><li>b</li></ul>');
    });

    it('renders number children', () =>
    {
        expect(renderToString(() => h('span', {}, 42))).toBe('<span>42</span>');
    });
});

describe('renderToString - attributes', () =>
{
    it('escapes attribute values', () =>
    {
        expect(renderToString(() => h('div', { title: 'a"b<c' }))).toBe('<div title="a&quot;b&lt;c"></div>');
    });

    it('emits a boolean attribute for true and omits it for false', () =>
    {
        expect(renderToString(() => h('button', { disabled: true }, 'x'))).toBe('<button disabled="">x</button>');
        expect(renderToString(() => h('button', { disabled: false }, 'x'))).toBe('<button>x</button>');
    });

    it('omits null and undefined attributes', () =>
    {
        expect(renderToString(() => h('div', { id: null, class: undefined }))).toBe('<div></div>');
    });

    it('skips event handlers and refs', () =>
    {
        const ref = { current: null };
        const html = renderToString(() => h('button', { onClick: () => undefined, ref }, 'x'));
        expect(html).toBe('<button>x</button>');
    });

    it('resolves a reactive attribute once', () =>
    {
        const [cls] = createSignal('active');
        expect(renderToString(() => h('div', { class: cls }))).toBe('<div class="active"></div>');
    });

    it('renders value/checked as attributes server-side', () =>
    {
        expect(renderToString(() => h('input', { value: 'v', checked: true }))).toBe('<input value="v" checked="">');
    });
});

describe('renderToString - void elements & content properties', () =>
{
    it('self-closes void elements with no children or closing tag', () =>
    {
        expect(renderToString(() => h('br', {}))).toBe('<br>');
        expect(renderToString(() => h('img', { src: 'a.png' }))).toBe('<img src="a.png">');
    });

    it('passes innerHTML through raw', () =>
    {
        expect(renderToString(() => h('div', { innerHTML: '<b>x</b>' }))).toBe('<div><b>x</b></div>');
    });

    it('escapes textContent', () =>
    {
        expect(renderToString(() => h('div', { textContent: '<b>' }))).toBe('<div>&lt;b&gt;</div>');
    });
});

describe('renderToString - reactive children & markers', () =>
{
    it('wraps a reactive child in comment anchors', () =>
    {
        const [count] = createSignal(0);
        const html = renderToString(() => h('span', {}, () => `Count: ${ count() }`));
        expect(html).toBe('<span><!--[-->Count: 0<!--]--></span>');
    });

    it('emits empty anchors for an empty reactive hole', () =>
    {
        const html = renderToString(() => h('span', {}, () => null));
        expect(html).toBe('<span><!--[--><!--]--></span>');
    });
});

describe('renderToStaticMarkup', () =>
{
    it('omits reactive-hole markers', () =>
    {
        const [count] = createSignal(7);
        expect(renderToStaticMarkup(() => h('span', {}, () => count()))).toBe('<span>7</span>');
    });
});
