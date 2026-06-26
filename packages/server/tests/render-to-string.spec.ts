// @vitest-environment node
//
// Real-execution coverage for renderToString + renderToStaticMarkup (render-to-string.ts).
// Runs in the `node` environment ON PURPOSE: `document` is undefined here, so these tests
// genuinely exercise the "SSR needs no DOM shim" contract - if any code path reached for the
// DOM it would throw ReferenceError, not silently pass against a happy-dom shim.
//
// No mocks: the real reactivity core (signals, memos, render-mode stack), the real renderer
// (h, control-flow), and the real string emitter run end to end.
import { describe, it, expect } from 'vitest';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';
import { h, Show, For, Switch, Match, Dynamic } from '@azerothjs/renderer';
import { createSignal, createMemo } from '@azerothjs/reactivity';

describe('renderToString - the no-DOM contract', () =>
{
    it('runs with document undefined (genuine bare-server execution)', () =>
    {
        // If this assertion is false the test is meaningless - it would be running against
        // a DOM shim and the "no document" guarantee below would be untested.
        expect(typeof document).toBe('undefined');
        expect(renderToString(() => h('h1', {}, 'hi'))).toBe('<h1>hi</h1>');
    });
});

describe('renderToString - element / attribute / text correctness', () =>
{
    it('serializes a single element with text', () =>
    {
        expect(renderToString(() => h('h1', {}, 'Hello'))).toBe('<h1>Hello</h1>');
    });

    it('serializes static attributes, lowercasing the tag', () =>
    {
        expect(renderToString(() => h('DIV', { id: 'box', class: 'card' })))
            .toBe('<div id="box" class="card"></div>');
    });

    it('emits a boolean-true attribute as an empty value and omits false/null/undefined', () =>
    {
        expect(renderToString(() => h('input', { disabled: true })))
            .toBe('<input disabled="">');
        expect(renderToString(() => h('input', { disabled: false, name: null, value: undefined })))
            .toBe('<input>');
    });

    it('serializes void elements with no closing tag and no content', () =>
    {
        expect(renderToString(() => h('br', {}))).toBe('<br>');
        expect(renderToString(() => h('img', { src: 'a.png', alt: 'x' })))
            .toBe('<img src="a.png" alt="x">');
    });

    it('drops event handlers and refs (no meaning in static HTML)', () =>
    {
        const ref = { current: null };
        expect(renderToString(() => h('button', { onClick: () => undefined, ref }, 'Go')))
            .toBe('<button>Go</button>');
    });

    it('serializes numbers and concatenates mixed children', () =>
    {
        expect(renderToString(() => h('p', {}, 'n=', 42, ' done'))).toBe('<p>n=42 done</p>');
    });

    it('skips null / undefined / false children but keeps 0', () =>
    {
        expect(renderToString(() => h('p', {}, null, undefined, false, 0, 'x')))
            .toBe('<p>0x</p>');
    });

    it('flattens array children', () =>
    {
        expect(renderToString(() => h('ul', {}, [h('li', {}, 'a'), h('li', {}, 'b')])))
            .toBe('<ul><li>a</li><li>b</li></ul>');
    });
});

describe('renderToString - nested components', () =>
{
    it('composes nested h() calls into one tree', () =>
    {
        const Item = (label: string): HTMLElement => h('li', { class: 'item' }, label);
        const List = (): HTMLElement => h('ul', {}, Item('one'), Item('two'));
        expect(renderToString(List))
            .toBe('<ul><li class="item">one</li><li class="item">two</li></ul>');
    });

    it('a thunk component that returns a built element serializes its tree', () =>
    {
        const App = (): HTMLElement =>
            h('section', { id: 'root' },
                h('header', {}, h('h1', {}, 'Title')),
                h('main', {}, h('p', {}, 'Body')));
        expect(renderToString(() => App()))
            .toBe('<section id="root"><header><h1>Title</h1></header><main><p>Body</p></main></section>');
    });
});

describe('renderToString - innerHTML / textContent content properties', () =>
{
    it('innerHTML is a RAW escape hatch (not escaped) and wins over children', () =>
    {
        expect(renderToString(() => h('div', { innerHTML: '<b>bold</b>' }, 'ignored')))
            .toBe('<div><b>bold</b></div>');
    });

    it('textContent is escaped and emitted as content', () =>
    {
        expect(renderToString(() => h('div', { textContent: '<b>not bold</b>' })))
            .toBe('<div>&lt;b&gt;not bold&lt;/b&gt;</div>');
    });
});

describe('renderToString - reactive prop / hole serialization', () =>
{
    it('resolves a reactive (function) attribute to its concrete value once', () =>
    {
        const [cls] = createSignal('active');
        expect(renderToString(() => h('div', { class: () => cls() })))
            .toBe('<div class="active"></div>');
    });

    it('wraps a reactive text hole in a SINGLE reactive-hole anchor pair (markers on)', () =>
    {
        const [name] = createSignal('Ada');
        expect(renderToString(() => h('span', {}, () => name())))
            .toBe('<span><!--[-->Ada<!--]--></span>');
    });

    it('serializes a signal hole computed from a memo, once', () =>
    {
        const [n] = createSignal(4);
        const parity = createMemo(() => (n() % 2 === 0 ? 'even' : 'odd'));
        expect(renderToString(() => h('span', {}, () => parity())))
            .toBe('<span><!--[-->even<!--]--></span>');
    });

    it('collapses a getter-returning-a-getter hole to its concrete value (one anchor pair)', () =>
    {
        const inner = (): string => 'deep';
        expect(renderToString(() => h('span', {}, () => inner)))
            .toBe('<span><!--[-->deep<!--]--></span>');
    });

    it('reads each reactive getter exactly ONCE - effects do not run on the server', () =>
    {
        let reads = 0;
        const [n] = createSignal(7);
        const hole = (): number =>
        {
            reads++;
            return n();
        };
        renderToString(() => h('p', {}, hole));
        expect(reads).toBe(1);
    });
});

describe('renderToString - control-flow string-mode paths (co-range comment markers)', () =>
{
    it('Show emits only the active (true) branch inside azc:show markers', () =>
    {
        const html = renderToString(() =>
            h('div', {}, Show({ when: true, children: () => h('p', {}, 'yes') })));
        expect(html).toBe('<div><!--azc:show--><p>yes</p><!--/azc--></div>');
    });

    it('Show with a false condition and no fallback emits an empty co-range', () =>
    {
        const html = renderToString(() =>
            h('div', {}, Show({ when: false, children: () => h('p', {}, 'yes') })));
        expect(html).toBe('<div><!--azc:show--><!--/azc--></div>');
    });

    it('Show with a false condition renders the fallback branch', () =>
    {
        const html = renderToString(() =>
            h('div', {}, Show({
                when: false,
                fallback: () => h('em', {}, 'nope'),
                children: () => h('p', {}, 'yes')
            })));
        expect(html).toBe('<div><!--azc:show--><em>nope</em><!--/azc--></div>');
    });

    it('For maps each item once into azc:for markers', () =>
    {
        const html = renderToString(() =>
            h('ul', {}, For({
                each: ['a', 'b', 'c'],
                key: (i) => i,
                children: (item) => h('li', {}, item)
            })));
        expect(html).toBe('<ul><!--azc:for--><li>a</li><li>b</li><li>c</li><!--/azc--></ul>');
    });

    it('For exposes a static index getter during SSR', () =>
    {
        const html = renderToString(() =>
            h('ol', {}, For({
                each: ['x', 'y'],
                key: (i) => i,
                children: (item, index) => h('li', {}, () => `${ index() }:${ item }`)
            })));
        expect(html).toBe('<ol><!--azc:for--><li><!--[-->0:x<!--]--></li><li><!--[-->1:y<!--]--></li><!--/azc--></ol>');
    });

    it('For with an empty list emits an empty for co-range', () =>
    {
        const html = renderToString(() =>
            h('ul', {}, For({ each: [] as string[], key: (i) => i, children: (i) => h('li', {}, i) })));
        expect(html).toBe('<ul><!--azc:for--><!--/azc--></ul>');
    });

    it('Switch emits the first matching case in azc:switch markers', () =>
    {
        const status = 'error';
        const html = renderToString(() =>
            h('div', {}, Switch({
                fallback: () => h('span', {}, 'idle'),
                children: [
                    Match({ when: () => status === 'loading', children: () => h('span', {}, 'loading') }),
                    Match({ when: () => status === 'error', children: () => h('span', {}, 'boom') })
                ]
            })));
        expect(html).toBe('<div><!--azc:switch--><span>boom</span><!--/azc--></div>');
    });

    it('Switch falls back when no case matches', () =>
    {
        const html = renderToString(() =>
            h('div', {}, Switch({
                fallback: () => h('span', {}, 'idle'),
                children: [Match({ when: () => false, children: () => h('span', {}, 'never') })]
            })));
        expect(html).toBe('<div><!--azc:switch--><span>idle</span><!--/azc--></div>');
    });

    it('Dynamic resolves the component + props once inside azc:dynamic markers', () =>
    {
        const Greeting = (props: Record<string, unknown>): HTMLElement =>
            h('h2', {}, `Hi ${ props.name as string }`);
        const html = renderToString(() =>
            h('div', {}, Dynamic({ component: () => Greeting, props: () => ({ name: 'Ada' }) })));
        expect(html).toBe('<div><!--azc:dynamic--><h2>Hi Ada</h2><!--/azc--></div>');
    });

    it('Dynamic with a null component emits an empty dynamic co-range', () =>
    {
        const html = renderToString(() =>
            h('div', {}, Dynamic({ component: () => null })));
        expect(html).toBe('<div><!--azc:dynamic--><!--/azc--></div>');
    });

    it('nested control-flow nests balanced co-range markers', () =>
    {
        const html = renderToString(() =>
            h('ul', {}, For({
                each: [1, 2],
                key: (n) => n,
                children: (n) => h('li', {}, Show({ when: n === 2, children: () => h('b', {}, 'two') }))
            })));
        expect(html).toBe(
            '<ul><!--azc:for-->' +
            '<li><!--azc:show--><!--/azc--></li>' +
            '<li><!--azc:show--><b>two</b><!--/azc--></li>' +
            '<!--/azc--></ul>'
        );
    });
});

describe('renderToStaticMarkup - markers OFF', () =>
{
    it('emits a reactive hole with no anchor pair', () =>
    {
        const [name] = createSignal('Ada');
        expect(renderToStaticMarkup(() => h('span', {}, () => name()))).toBe('<span>Ada</span>');
    });

    it('emits control-flow output with no co-range markers', () =>
    {
        const html = renderToStaticMarkup(() =>
            h('ul', {}, For({
                each: ['a', 'b'],
                key: (i) => i,
                children: (item) => h('li', {}, item)
            })));
        expect(html).toBe('<ul><li>a</li><li>b</li></ul>');
    });

    it('produces identical structure to renderToString minus every marker comment', () =>
    {
        const build = (): HTMLElement =>
            h('div', {},
                Show({ when: true, children: () => h('p', {}, () => 'hi') }));

        const withMarkers = renderToString(build);
        const withoutMarkers = renderToStaticMarkup(build);

        expect(withMarkers).toBe('<div><!--azc:show--><p><!--[-->hi<!--]--></p><!--/azc--></div>');
        expect(withoutMarkers).toBe('<div><p>hi</p></div>');
        // Stripping the framework comment markers from the hydration-ready output yields exactly
        // the static output.
        expect(withMarkers.replace(/<!--\[-->|<!--\]-->|<!--azc:[a-z]+-->|<!--\/azc-->/g, ''))
            .toBe(withoutMarkers);
    });
});

describe('renderToString - escaping / XSS', () =>
{
    it('escapes &, <, > in text content', () =>
    {
        expect(renderToString(() => h('p', {}, 'a & b < c > d')))
            .toBe('<p>a &amp; b &lt; c &gt; d</p>');
    });

    it('escapes a static attacker-controlled attribute so it cannot break out', () =>
    {
        const evil = 'x" onmouseover="steal()';
        expect(renderToString(() => h('div', { title: evil })))
            .toBe('<div title="x&quot; onmouseover=&quot;steal()"></div>');
    });

    it('escapes a REACTIVE attribute value so a signal cannot inject an attribute', () =>
    {
        const [title] = createSignal('"><script>alert(1)</script>');
        const html = renderToString(() => h('div', { title: () => title() }));
        expect(html).toBe('<div title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"></div>');
        // The closing quote of the value is the only unescaped double quote in the tag.
        expect(html.indexOf('"', html.indexOf('title="') + 'title="'.length))
            .toBe(html.indexOf('">'));
    });

    it('escapes a REACTIVE text hole so an attacker value cannot open a tag', () =>
    {
        const [comment] = createSignal('<img src=x onerror=alert(1)>');
        expect(renderToString(() => h('div', {}, () => comment())))
            .toBe('<div><!--[-->&lt;img src=x onerror=alert(1)&gt;<!--]--></div>');
    });

    it('escapes text passed through a control-flow branch', () =>
    {
        const [name] = createSignal('<script>evil</script>');
        const html = renderToString(() =>
            h('div', {}, Show({ when: true, children: () => h('span', {}, () => name()) })));
        expect(html).toBe('<div><!--azc:show--><span><!--[-->&lt;script&gt;evil&lt;/script&gt;<!--]--></span><!--/azc--></div>');
    });

    it('escapes a For item value so list data cannot inject markup', () =>
    {
        const html = renderToString(() =>
            h('ul', {}, For({
                each: ['<b>x</b>'],
                key: (i) => i,
                children: (item) => h('li', {}, item)
            })));
        expect(html).toBe('<ul><!--azc:for--><li>&lt;b&gt;x&lt;/b&gt;</li><!--/azc--></ul>');
    });

    it('innerHTML remains a DELIBERATE raw escape hatch (NOT escaped) even from a signal', () =>
    {
        const [markup] = createSignal('<b>trusted</b>');
        expect(renderToString(() => h('div', { innerHTML: () => markup() })))
            .toBe('<div><b>trusted</b></div>');
    });
});

describe('renderToString / renderToStaticMarkup - marker-state isolation', () =>
{
    it('a static render between two string renders does not leak its markers-off state', () =>
    {
        const [v] = createSignal('x');
        const first = renderToString(() => h('span', {}, () => v()));
        renderToStaticMarkup(() => h('span', {}, () => v()));
        const third = renderToString(() => h('span', {}, () => v()));
        // Both string renders still carry the anchor pair - the intervening static render
        // restored the marker flag in its finally block.
        expect(first).toBe('<span><!--[-->x<!--]--></span>');
        expect(third).toBe('<span><!--[-->x<!--]--></span>');
    });

    it('restores the marker flag even when the render throws', () =>
    {
        expect(() => renderToString(() =>
        {
            throw new Error('boom');
        })).toThrow('boom');

        // The next string render is unaffected - markers were restored in the finally.
        const [v] = createSignal('ok');
        expect(renderToString(() => h('span', {}, () => v())))
            .toBe('<span><!--[-->ok<!--]--></span>');
    });
});
