// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, h, hydrate, render, renderToStream, renderToString, Show } from 'azerothjs';
import { compileComponent } from './conformance/executor.ts';

const container = document.createElement('div');
beforeEach(() => document.body.append(container));
afterEach(() =>
{
    render(() => document.createElement('i'), container);
    container.remove();
});

const definitions = `const LABEL = "Atlas";
component Row(props) { <section>{ props.children({ title: LABEL }) }</section> }`;

// The output here is the wire contract. The browser parses it before startup, so
// consecutive primitives may become one Text and an empty string may leave none.
const shapes = [
    ['module constant beside text', '<i>Desk: { LABEL }</i>', '<i>Desk: Atlas</i>'],
    ['local constant beside text', '<i>{ local } desk</i>', '<i>Atlas desk</i>'],
    ['render callback parameter', '<Row>{ item => <i>Desk: { item.title }</i> }</Row>', '<i>Desk: Atlas</i>'],
    ['empty string', '<i>{ empty }</i>', '<i></i>'],
    ['nested array', '<i>{ parts }</i>', '<i>A&lt;&amp;0B</i>'],
    ['empty values between elements', '<i><b/>{ empty }<em/></i>', '<i><b></b><em></em></i>'],
    ['elements separating text runs', '<i>A{ local }<b/>B{ local }</i>', '<i>AAtlas<b></b>BAtlas</i>'],
    ['isolated constant', '<i>{ LABEL }</i>', '<i>Atlas</i>'],
    ['zero', '<i>{ zero }</i>', '<i>0</i>'],
    ['null', '<i>{ absent }</i>', '<i></i>'],
    ['false', '<i>{ hidden }</i>', '<i></i>'],
    ['array inside a reactive hole', '<i>{ props.parts }</i>', '<i><!--[-->xy<!--]--></i>']
] as const;

describe.each(['buffered', 'streamed'] as const)('%s SSR static text adoption', mode =>
{
    it.each(shapes)('%s keeps the draft and wires the served button', async (_name, markup, servedHTML) =>
    {
        const Component = compileComponent(definitions + `component Page(props) {
            const local = LABEL;
            const empty = "";
            const parts = ["A", [null, "", ["<&", 0]], false, "B"];
            const zero = 0;
            const absent = null;
            const hidden = false;
            <main><form><input/></form>${ markup }<button onClick={ props.increment }>{ props.count }</button></main>
        }`, 'Page', { ssr: true });
        const [count, setCount] = createSignal(0);
        const app = () => Component({ get count()
        {
            return count();
        }, increment: () => setCount(value => value + 1), parts: ['x', 'y'] }) as HTMLElement;
        const html = mode === 'buffered' ? renderToString(app) : await new Response(renderToStream(app)).text();
        expect(html).toContain(servedHTML);
        container.innerHTML = html;
        const form = container.querySelector('form')!;
        const input = form.querySelector('input')!;
        const button = container.querySelector('button')!;
        const label = container.querySelector('i')!;
        const servedChildren = Array.from(label.childNodes);
        input.value = 'early draft';
        input.focus();
        input.setSelectionRange(1, 4);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        hydrate(app, container);

        expect(container.querySelector('form')).toBe(form);
        expect(warn).not.toHaveBeenCalled();
        expect(container.querySelector('i')).toBe(label);
        // Reactive array contents have their own patcher. Static adoption keeps
        // the parsed text nodes as well as the element containing them.
        if (!servedHTML.includes('<!--[-->'))
        {
            expect(label.childNodes).toHaveLength(servedChildren.length);
            for (const [index, node] of servedChildren.entries())
            {
                expect(label.childNodes[index]).toBe(node);
            }
        }
        expect(container.querySelector('input')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['early draft', 1, 4]);
        button.click();
        expect(container.querySelector('button')).toBe(button);
        expect(button.textContent).toBe('1');
    });
});

it('adopts the parsed text without rewriting a differing client snapshot or splitting it by length', () =>
{
    const Page = compileComponent(`component Page(props) {
        const caption = props.caption;
        <label>{ caption }{ caption }</label>
    }`, 'Page');
    const app = (caption: string) => Page({ caption }) as HTMLElement;
    container.innerHTML = renderToString(() => app('line\r\n'));
    // Browsers normalize input newlines. happy-dom may preserve them.
    const label = container.querySelector('label')!;
    const text = label.firstChild as Text;
    text.data = text.data.replace(/\r\n/g, '\n');
    expect(text.data).toBe('line\nline\n');
    hydrate(() => app('new client snapshot'), container);
    expect(container.firstChild).toBe(label);
    expect(label.firstChild).toBe(text);
    expect(label.childNodes).toHaveLength(1);
    expect(text.data).toBe('line\nline\n');
});

it('can claim two explicitly separate Text nodes and keep both references', () =>
{
    const app = () => h('div', {}, 'A', [false, null], 'BC');
    container.innerHTML = renderToString(app);
    const el = container.firstChild!;
    const first = el.firstChild as Text;
    const second = first.splitText(1);
    hydrate(app, container);
    expect(container.firstChild).toBe(el);
    expect(el.firstChild).toBe(first);
    expect(el.lastChild).toBe(second);
});

it.each(['before', 'after'] as const)('keeps an explicit empty Text %s a nonempty one', position =>
{
    const app = () => h('p', {}, ...(position === 'before' ? ['', 'Atlas'] : ['Atlas', '']), h('b', {}));
    container.innerHTML = renderToString(app);
    const p = container.querySelector('p')!;
    const first = p.firstChild as Text;
    const second = first.splitText(position === 'before' ? 0 : first.length);
    const b = p.lastChild;
    hydrate(app, container);
    expect(container.firstChild).toBe(p);
    expect(p.childNodes[0]).toBe(first);
    expect(p.childNodes[1]).toBe(second);
    expect(p.childNodes[2]).toBe(b);
});

it('keeps existing text when an isolated client snapshot becomes empty', () =>
{
    container.innerHTML = renderToString(() => h('p', {}, 'served'));
    const p = container.querySelector('p')!;
    const text = p.firstChild;
    hydrate(() => h('p', {}, ''), container);
    expect(container.firstChild).toBe(p);
    expect(p.firstChild).toBe(text);
    expect(p.textContent).toBe('served');
});

it('cannot share a static text claim with an absent opaque node', () =>
{
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    container.innerHTML = '<section>served</section>';
    const old = container.firstChild;
    hydrate(() => h('section', {}, 'served', document.createElement('button')), container);
    expect(container.firstChild).not.toBe(old);
    expect(container.querySelector('button')).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
});

it('an empty leaf in a fresh cursor cannot satisfy the next nonempty leaf', () =>
{
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    container.innerHTML = '<main>header<p><b></b></p></main>';
    const old = container.firstChild;
    hydrate(() => h('main', {}, 'header', h('p', {}, '', 'required', h('b', {}))), container);
    expect(container.firstChild).not.toBe(old);
    expect(container.querySelector('p')?.textContent).toBe('required');
    expect(warn).toHaveBeenCalledTimes(1);
});

it.each(['element', 'reactive hole', 'Show range'] as const)(
    'still detects a genuinely absent text run after an adopted %s', boundary =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = () => h('div', {}, 'left', boundary === 'element' ? h('b', {}) :
            boundary === 'reactive hole' ? () => 'live' : Show({ when: true, children: () => h('i', {}) }), 'right');
        container.innerHTML = renderToString(app);
        const server = container.firstChild!;
        expect(server.lastChild?.textContent).toBe('right');
        server.removeChild(server.lastChild!);
        hydrate(app, container);
        expect(container.firstChild).not.toBe(server);
        expect(container.textContent).toMatch(/right$/);
        expect(warn).toHaveBeenCalledTimes(1);
    }
);
