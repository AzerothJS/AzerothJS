// @vitest-environment happy-dom
//
// Regression: a hole inside <textarea> or <title> expects anchors the parser never makes, so text
// beside one throws and hydration rebuilds the page; form.reset() empties a value-owned field.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEffect, createRoot, createSignal, h, hydrate, render, renderToString } from 'azerothjs';
import { bindProps, bindText } from 'azerothjs/internal';

const XHTML = 'http://www.w3.org/1999/xhtml';
const TEXT_ONLY = new Set(['textarea', 'title', 'noscript']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
const INTEGRATION = new Set(['foreignobject', 'desc', 'title']);
const TAG = /^<(\/?)([a-zA-Z][^\t\n\f />]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/;
const MARK = 'data-served-text';

// Cuts each textarea, title and noscript in HTML content out of the page source by the tokenizer's
// end-tag rule and escapes it, so happy-dom reads it as the one text a scripted browser reads.
function rebuildSource(html: string): string
{
    let out = '';
    let i = 0;
    const open: { name: string; html: boolean }[] = [];
    while (i < html.length)
    {
        const lt = html.indexOf('<', i);
        if (lt < 0)
        {
            out += html.slice(i);
            break;
        }
        out += html.slice(i, lt);
        if (html.startsWith('<!--', lt))
        {
            const end = /-->|--!>/.exec(html.slice(lt + 4));
            const stop = end ? lt + 4 + end.index + end[0].length : html.length;
            out += html.slice(lt, stop);
            i = stop;
            continue;
        }
        const tag = TAG.exec(html.slice(lt));
        if (!tag)
        {
            out += '<';
            i = lt + 1;
            continue;
        }
        const [whole, slash, rawName, attrs] = tag as unknown as [string, string, string, string];
        const name = rawName.toLowerCase();
        const selfClosing = /\/\s*$/.test(attrs);
        const inHtml = open.length === 0 || open[open.length - 1]!.html;
        i = lt + whole.length;
        if (slash)
        {
            if (open.length > 0 && open[open.length - 1]!.name === name)
            {
                open.pop();
            }
            out += whole;
            continue;
        }
        if (!inHtml)
        {
            if (!selfClosing && (name === 'svg' || name === 'math' || INTEGRATION.has(name)))
            {
                open.push({ name, html: INTEGRATION.has(name) });
            }
            out += whole;
            continue;
        }
        if (name === 'svg' || name === 'math')
        {
            if (!selfClosing)
            {
                open.push({ name, html: false });
            }
            out += whole;
            continue;
        }
        if (TEXT_ONLY.has(name) || RAW_TEXT.has(name))
        {
            const close = new RegExp(`</${ name }[\\t\\n\\f />]`, 'i').exec(html.slice(i));
            const stop = close ? i + close.index : html.length;
            const content = html.slice(i, stop).replace(/\r\n?/g, '\n');
            if (RAW_TEXT.has(name))
            {
                out += whole + content;
            }
            else
            {
                const escaped = (name === 'noscript' ? content.replace(/&/g, '&amp;') : content).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                out += `<${ rawName } ${ MARK }${ whole.slice(1 + rawName.length) }${ escaped }`;
            }
            i = stop;
            continue;
        }
        out += whole;
    }
    return out;
}

// A served page as a scripted browser reads it. An svg title keeps its parse; a textarea or a title
// inside foreignObject is HTML, and one LF right after <textarea> is dropped.
function served(html: string): HTMLElement
{
    const container = document.createElement('div');
    container.innerHTML = rebuildSource(html);
    for (const el of Array.from(container.querySelectorAll(`[${ MARK }]`)))
    {
        let target = el;
        if (el.namespaceURI !== XHTML)
        {
            target = document.createElement(el.localName);
            for (const attr of Array.from(el.attributes))
            {
                target.setAttribute(attr.name, attr.value);
            }
            target.textContent = el.textContent;
            el.replaceWith(target);
        }
        target.removeAttribute(MARK);
        const text = target.textContent;
        if (target.localName === 'textarea' && text.startsWith('\n'))
        {
            target.textContent = text.slice(1);
        }
    }
    document.body.appendChild(container);
    return container;
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Read once: vitest restores two spies on one accessor so that one of them stays installed.
const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;

// A leftover title would take the next test's document.title write, a leftover value spy its reads.
afterEach(() =>
{
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'value', nativeValue);
});

describe('the served() helper reads a page as a scripted browser does (control)', () =>
{
    const read = (html: string): { tag: string; ns: string | null; kids: string[][] }[] =>
        Array.from(served(html).querySelectorAll('textarea, title, noscript')).map((el) => ({
            tag: el.localName,
            ns: el.namespaceURI,
            kids: Array.from(el.childNodes).map((kid) => kid.nodeType === 3 ? ['text', (kid as Text).data] : kid.nodeType === 8 ? ['comment', (kid as Comment).data] : ['el', (kid as Element).localName])
        }));
    const text = (html: string): string[][] => read(html).map((el) => el.kids.flat());

    it('reads the content of a textarea, a title and a noscript as one text, as three engines do', () =>
    {
        expect(text('<textarea>Hello <!--[-->hi<!--]--></textarea>')).toEqual([['text', 'Hello <!--[-->hi<!--]-->']]);
        expect(text('<textarea>a --> b</textarea>')).toEqual([['text', 'a --> b']]);
        expect(text('<title>x --> y</title>')).toEqual([['text', 'x --> y']]);
        expect(text('<title>a</b>c</title>')).toEqual([['text', 'a</b>c']]);
        expect(text('<textarea>&lt;b&gt; &amp;amp;</textarea>')).toEqual([['text', '<b> &amp;']]);
        expect(text('<noscript><p>Hello <!--[-->hi<!--]--></p></noscript>')).toEqual([['text', '<p>Hello <!--[-->hi<!--]--></p>']]);
    });

    it('drops one leading LF after <textarea>, normalizes raw line breaks and keeps a CR reference', () =>
    {
        expect(text('<textarea>\n\nx</textarea>')).toEqual([['text', '\nx']]);
        expect(text('<textarea>a\r\nb</textarea>')).toEqual([['text', 'a\nb']]);
        expect(text('<textarea>\n&#13;x</textarea>')).toEqual([['text', '\rx']]);
    });

    it('keeps an svg title\'s parse and reads a textarea inside foreignObject as HTML', () =>
    {
        expect(read('<div><svg><title>a <!--[-->hi<!--]--></title></svg></div>')).toEqual([{
            tag: 'title',
            ns: 'http://www.w3.org/2000/svg',
            kids: [['text', 'a '], ['comment', '['], ['text', 'hi'], ['comment', ']']]
        }]);
        expect(read('<svg><foreignObject><textarea>t</textarea></foreignObject></svg>')).toEqual([{ tag: 'textarea', ns: XHTML, kids: [['text', 't']] }]);
    });
});

describe('the DOM path builds one text node', () =>
{
    it('joins text and holes, and patches that node on update', () =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        render(() => h('textarea', { name: 't' }, 'Hello ', () => v(), '!'), container);
        const ta = container.querySelector('textarea')!;
        const node = ta.firstChild;

        expect(ta.childNodes.length).toBe(1);
        expect(ta.value).toBe('Hello hi!');
        setV('v2');
        expect(ta.firstChild).toBe(node);
        expect(ta.value).toBe('Hello v2!');
    });

    it('refuses an element child, a hole that gives one, and value beside a content property', () =>
    {
        expect(() => render(() => h('title', {}, h('b', {}, 'x')), document.createElement('div')))
            .toThrow(/A hole inside <title> gives text/);
        expect(() => render(() => h('textarea', {}, () => h('b', {}, 'x')), document.createElement('div')))
            .toThrow(/A hole inside <textarea> gives text/);
        expect(() => render(() => h('textarea', { value: 'a', textContent: 'b' }), document.createElement('div')))
            .toThrow(/'value' and 'textContent' both set a <textarea>'s text/);
    });

    it('lets a value win over children, as its text and its default', () =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        render(() => h('textarea', { value: () => v() }, 'kid'), container);
        const ta = container.querySelector('textarea')!;

        expect(ta.value).toBe('hi');
        expect(ta.defaultValue).toBe('hi');
        setV('v2');
        expect(ta.value).toBe('v2');
        expect(ta.defaultValue).toBe('v2');
    });

    it('bindText drives a cloned textarea the same way', () =>
    {
        const [v, setV] = createSignal('hi');
        const ta = document.createElement('textarea');
        bindText(ta, 'Hello ', () => v());

        expect(ta.childNodes.length).toBe(1);
        expect(ta.value).toBe('Hello hi');
        setV('v2');
        expect(ta.value).toBe('Hello v2');
    });

    it('bindText yields to a spread-carried value when the clone is built inside an effect re-run', () =>
    {
        const [step, setStep] = createSignal(0);
        const [v] = createSignal('hi');
        const [w] = createSignal('kid');
        const form = document.createElement('form');
        document.body.appendChild(form);
        createRoot(() => createEffect(() =>
        {
            if (step() === 0)
            {
                return;
            }
            // What a compiled <textarea {...props}>{ w }</textarea> clone runs, inside a flush.
            const ta = document.createElement('textarea');
            form.appendChild(ta);
            bindProps(ta, { ...{ value: () => v() } });
            bindText(ta, () => w());
        }));
        setStep(1);
        const ta = form.querySelector('textarea')!;

        expect(ta.value).toBe('hi');
        expect(ta.defaultValue).toBe('hi');
        form.reset();
        expect(ta.value).toBe('hi');
    });

    it('builds a noscript without its content', () =>
    {
        const container = document.createElement('div');
        render(() => h('div', {}, h('noscript', {}, h('img', { src: '/pixel.gif' })), 'x'), container);

        expect(container.innerHTML).toBe('<div><noscript></noscript>x</div>');
    });
});

describe('hydration adopts what the parser served', () =>
{
    it('keeps the served text node of a textarea and a title and patches it on update', () =>
    {
        const warn = vi.spyOn(console, 'warn');
        const [v, setV] = createSignal('hi');
        const view = (): HTMLElement => h('div', {}, h('textarea', { name: 't' }, 'Hello ', () => v()), h('title', {}, () => v(), ' - Site'));
        const container = served(renderToString(view));
        const ta = container.querySelector('textarea')!;
        const node = ta.firstChild;
        const title = container.querySelector('title')!;

        hydrate(view, container);
        expect(container.querySelector('textarea')).toBe(ta);
        expect(ta.firstChild).toBe(node);
        expect(warn).not.toHaveBeenCalled();

        setV('v2');
        expect(ta.firstChild).toBe(node);
        expect(ta.value).toBe('Hello v2');
        expect(title.text).toBe('v2 - Site');
    });

    it('folds the comments an earlier build served inside an svg title', () =>
    {
        const warn = vi.spyOn(console, 'warn');
        const [v, setV] = createSignal('hi');
        const view = (): HTMLElement => h('div', {}, h('svg', {}, h('title', {}, 'a ', () => v())));
        const container = served('<div><svg><title>a <!--[-->hi<!--]--></title></svg></div>');
        const title = container.querySelector('title')!;

        hydrate(view, container);
        expect(container.querySelector('title')).toBe(title);
        expect(title.childNodes.length).toBe(1);
        expect(title.textContent).toBe('a hi');
        expect(warn).not.toHaveBeenCalled();
        setV('hi!');
        expect(title.textContent).toBe('a hi!');
    });

    it('refuses an element served inside a title as text-only content', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const view = (): HTMLElement => h('div', {}, h('svg', {}, h('title', {}, 'x')));
        const container = served('<div><svg><title><tspan>x</tspan></title></svg></div>');

        hydrate(view, container);
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/<title> holds text only, found <tspan>/);
    });

    it('adopts a textarea whose value was served as its text', () =>
    {
        const warn = vi.spyOn(console, 'warn');
        const [v, setV] = createSignal('hi');
        const view = (): HTMLElement => h('form', {}, h('textarea', { name: 't', value: () => v() }));
        const container = served(renderToString(view));
        const ta = container.querySelector('textarea')!;

        expect(ta.value).toBe('hi');
        hydrate(view, container);
        expect(container.querySelector('textarea')).toBe(ta);
        expect(warn).not.toHaveBeenCalled();
        setV('v2');
        expect(ta.value).toBe('v2');
        expect(ta.defaultValue).toBe('v2');
    });

    it('fills a textarea the server left empty', () =>
    {
        const [v, setV] = createSignal('');
        const view = (): HTMLElement => h('div', {}, h('textarea', {}, () => v()));
        const container = served(renderToString(view));
        const ta = container.querySelector('textarea')!;

        expect(ta.childNodes.length).toBe(0);
        hydrate(view, container);
        expect(container.querySelector('textarea')).toBe(ta);
        setV('x');
        expect(ta.value).toBe('x');
        expect(ta.childNodes.length).toBe(1);
    });

    it('adopts a noscript and leaves its served content', () =>
    {
        const warn = vi.spyOn(console, 'warn');
        const view = (): HTMLElement => h('div', {}, h('noscript', {}, h('p', {}, 'Enable JS')), h('i', {}, 'x'));
        const container = served(renderToString(view));
        const noscript = container.querySelector('noscript')!;
        const content = noscript.innerHTML;

        hydrate(view, container);
        expect(container.querySelector('noscript')).toBe(noscript);
        expect(noscript.innerHTML).toBe(content);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('a value-owned textarea and its form', () =>
{
    it('writes nothing on an echo of the user input, and form.reset() restores the bound text', async () =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('form', {}, h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) })), container);
        const form = container.querySelector('form')!;
        const ta = container.querySelector('textarea')!;
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((list) => records.push(...list));
        observer.observe(ta, { childList: true, characterData: true, subtree: true });

        ta.value = 'hi!';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();
        expect(v()).toBe('hi!');
        expect(records).toEqual([]);

        form.reset();
        expect(ta.value).toBe('hi!');
        observer.disconnect();
    });

    it('writes no value at hydration or on an echo when the bound text holds a CRLF', async () =>
    {
        // A browser's value property reads a CR or a CRLF as LF; happy-dom's keeps them.
        vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'get').mockImplementation(function (this: HTMLTextAreaElement)
        {
            return (nativeValue.get!.call(this) as string).replace(/\r\n?/g, '\n');
        });
        const writes = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set');
        const [v, setV] = createSignal('a\r\nb');
        const view = (): HTMLElement => h('form', {}, h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) }));
        const container = served(renderToString(view));
        const ta = container.querySelector('textarea')!;

        hydrate(view, container);
        await settled();
        expect(writes).toHaveBeenCalledTimes(0);
        expect(ta.defaultValue).toBe('a\r\nb');

        ta.value = 'a\nb!';
        writes.mockClear();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();
        expect(v()).toBe('a\nb!');
        expect(writes).toHaveBeenCalledTimes(0);
    });

    it('writes no value at hydration or on an echo when the bound text holds a lone CR', async () =>
    {
        vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'get').mockImplementation(function (this: HTMLTextAreaElement)
        {
            return (nativeValue.get!.call(this) as string).replace(/\r\n?/g, '\n');
        });
        const writes = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set');
        const [v, setV] = createSignal('a\rb');
        const view = (): HTMLElement => h('form', {}, h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) }));
        const html = renderToString(view);
        const container = served(html);
        const ta = container.querySelector('textarea')!;
        expect(html).toContain('a&#13;b');
        expect(ta.defaultValue).toBe('a\rb');

        hydrate(view, container);
        await settled();
        expect(writes).toHaveBeenCalledTimes(0);
        expect(ta.defaultValue).toBe('a\rb');

        setV('c\rd');
        await settled();
        expect(writes).toHaveBeenCalledTimes(1);
        ta.value = 'c\nd!';
        writes.mockClear();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();
        expect(v()).toBe('c\nd!');
        expect(writes).toHaveBeenCalledTimes(0);
    });

    it('restores a bound textarea and settles a select when a form handler stops the reset', async () =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('form', { onReset: (event: Event) => event.stopPropagation() },
            h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) }),
            h('select', { value: 'de' }, h('option', { value: 'us' }, 'us'), h('option', { value: 'de' }, 'de'))), container);
        const form = container.querySelector('form')!;
        const ta = container.querySelector('textarea')!;
        const select = container.querySelector('select')!;

        ta.value = 'hi!';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        form.reset();
        await settled();
        expect(ta.value).toBe('hi!');
        expect(select.value).toBe('de');
    });

    it.each([
        ['a form (control)', false],
        ['a form whose elements a control named elements shadows', true]
    ])('restores the textarea and settles the select of %s', async (_form, shadow) =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('form', {},
            h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) }),
            h('select', { value: 'de' }, h('option', { value: 'us' }, 'us'), h('option', { value: 'de' }, 'de')),
            h('input', { name: 'elements', value: 'e' })), container);
        const form = container.querySelector('form')!;
        const ta = container.querySelector('textarea')!;
        const input = container.querySelector('input')!;
        // happy-dom answers form.elements before a named control, so an own property shadows it.
        if (shadow)
        {
            Object.defineProperty(form, 'elements', { value: input, configurable: true });
        }
        expect(form.elements === (input as unknown)).toBe(shadow);

        ta.value = 'hi!';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await settled();
        form.reset();
        const text = ta.value;
        await settled();
        expect({ text, select: container.querySelector('select')!.value }).toEqual({ text: 'hi!', select: 'de' });
    });

    it('writes the value before the default text', () =>
    {
        const [v, setV] = createSignal('hi');
        const container = document.createElement('div');
        render(() => h('textarea', { value: () => v() }), container);
        const value = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set');
        const data = vi.spyOn(Text.prototype, 'data', 'set');
        const content = vi.spyOn(Element.prototype, 'textContent', 'set');

        setV('v2');
        const defaults = [...data.mock.invocationCallOrder, ...content.mock.invocationCallOrder];
        expect(value.mock.invocationCallOrder).toHaveLength(1);
        expect(defaults.length).toBeGreaterThan(0);
        expect(Math.min(...defaults)).toBeGreaterThan(value.mock.invocationCallOrder[0]!);
    });
});

describe('a state written while the reset is dispatched', () =>
{
    // happy-dom's form.reset() resets before it dispatches; a dispatched reset runs the listeners
    // as a browser does, so the default text at its end is what a browser's reset then restores.
    const reset = (form: HTMLFormElement): boolean => form.dispatchEvent(new Event('reset', { bubbles: true, cancelable: true }));

    const mount = (view: () => HTMLElement): HTMLElement =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(view, container);
        return container;
    };

    // Value-owned fields whose state the user's edit does not reach.
    const fields: readonly (readonly [string, (v: () => string, setV: (text: string) => void) => HTMLElement])[] = [
        ['a one-way value', (v) => h('textarea', { value: () => v() })],
        ['a spread value', (v) =>
        {
            // What a compiled <textarea {...props}> clone runs.
            const ta = document.createElement('textarea');
            bindProps(ta, { ...{ value: () => v() } });
            return ta;
        }],
        ['a value with onChange', (v, setV) => h('textarea', { value: () => v(), onChange: (event: Event) => setV((event.target as HTMLTextAreaElement).value) })]
    ];

    // Each page runs `write` from a different point of the field's form reset.
    const writers: readonly (readonly [string, (field: () => HTMLElement, write: () => void) => HTMLElement])[] = [
        ['the form\'s handler', (field, write) => h('form', { onReset: write }, field())],
        ['a handler that stops the event', (field, write) => h('form', { onReset: (event: Event) =>
        {
            write();
            event.stopImmediatePropagation();
        } }, field())],
        ['an ancestor\'s handler', (field, write) => h('div', { onReset: write }, h('form', {}, field()))],
        ['a handler that resets another form first', (field, write) => h('div', {},
            h('form', { onReset: (event: Event) =>
            {
                reset((event.currentTarget as HTMLElement).nextElementSibling as HTMLFormElement);
                write();
            } }, field()),
            h('form', {}, h('textarea', { value: 'b' })))],
        ['a handler that dispatches a reset of its own form first', (field, write) =>
        {
            let inner = false;
            return h('form', { onReset: (event: Event) =>
            {
                if (inner)
                {
                    return;
                }
                inner = true;
                reset(event.currentTarget as HTMLFormElement);
                inner = false;
                write();
            } }, field());
        }],
        ['a window listener that stops the event', (field, write) =>
        {
            window.addEventListener('reset', (event) =>
            {
                write();
                event.stopPropagation();
            }, { capture: true, once: true });
            return h('form', {}, field());
        }]
    ];

    it.each(writers)('lands on a state that %s writes equal to what the field shows', (_writer, page) =>
    {
        for (const [shape, field] of fields)
        {
            for (const edit of ['', 'bye'])
            {
                const [v, setV] = createSignal('hi');
                const container = mount(() => page(() => field(v, setV), () => setV(edit)));
                const ta = container.querySelector('textarea')!;

                ta.value = edit;
                reset(container.querySelector('form')!);
                expect([v(), ta.defaultValue], `${ shape }, edited to '${ edit }'`).toEqual([edit, edit]);
            }
        }
    });

    it('lands on the state with an echo binding, and with a write that differs from the field (control)', () =>
    {
        for (const edit of ['', 'bye'])
        {
            const [v, setV] = createSignal('hi');
            const echo = mount(() => h('form', { onReset: () => setV(edit) }, h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) })));
            const ta = echo.querySelector('textarea')!;
            ta.value = edit;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            reset(echo.querySelector('form')!);
            expect([v(), ta.defaultValue], `echo, edited to '${ edit }'`).toEqual([edit, edit]);

            const [w, setW] = createSignal('hi');
            const typed = mount(() => h('form', { onReset: () => setW(edit) }, h('textarea', { value: () => w() })));
            const field = typed.querySelector('textarea')!;
            field.value = 'hiXYZ';
            reset(typed.querySelector('form')!);
            expect([w(), field.defaultValue], `typed, written '${ edit }'`).toEqual([edit, edit]);
        }
    });

    it('lands an echo binding on its state when a window listener stops the reset', () =>
    {
        const [v, setV] = createSignal('hi');
        const container = mount(() => h('form', {}, h('textarea', { value: () => v(), onInput: (event: Event) => setV((event.target as HTMLTextAreaElement).value) })));
        const ta = container.querySelector('textarea')!;
        window.addEventListener('reset', (event) => event.stopPropagation(), { capture: true, once: true });

        ta.value = 'hiXYZ';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        reset(container.querySelector('form')!);
        expect([v(), ta.defaultValue]).toEqual(['hiXYZ', 'hiXYZ']);
    });

    it('leaves the default behind an equal write made outside a reset, also after one finished (control)', () =>
    {
        for (const resetFirst of [false, true])
        {
            const [v, setV] = createSignal('hi');
            const container = mount(() => h('form', {}, h('textarea', { value: () => v() })));
            const ta = container.querySelector('textarea')!;
            if (resetFirst)
            {
                reset(container.querySelector('form')!);
            }

            ta.value = '';
            setV('');
            expect([v(), ta.defaultValue], `after a reset: ${ resetFirst }`).toEqual(['', 'hi']);
        }
    });
});

describe('a title whose node a document.title write replaced', () =>
{
    it('follows the next update in a client render and after hydration', () =>
    {
        const [v, setV] = createSignal('one');
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() => h('title', {}, () => v()), container);
        document.title = 'manual';
        setV('two');
        expect(container.querySelector('title')!.textContent).toBe('two');
        container.remove();

        const [w, setW] = createSignal('one');
        const view = (): HTMLElement => h('div', {}, h('title', {}, () => w()));
        const page = served(renderToString(view));
        hydrate(view, page);
        document.title = 'manual';
        setW('two');
        expect(page.querySelector('title')!.textContent).toBe('two');
    });
});
