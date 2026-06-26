// @vitest-environment happy-dom
//
// Full behavioral coverage for h() (h.ts): DOM creation, static + reactive
// attributes/properties, event binding, reactive children (surgical text-node
// patching with node identity preserved), child flattening, null/false skipping,
// element/text transitions, and refs. Real signals + real happy-dom, no mocks.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, batch } from '@azerothjs/reactivity';
import { h, createRef } from '@azerothjs/renderer';

describe('h — element creation', () =>
{
    it('creates a real element of the requested tag', () =>
    {
        const el = h('section', {});
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.tagName).toBe('SECTION');
    });

    it('applies static attributes via setAttribute', () =>
    {
        const el = h('a', { href: '/home', id: 'link', 'data-x': 'y' });
        expect(el.getAttribute('href')).toBe('/home');
        expect(el.getAttribute('id')).toBe('link');
        expect(el.getAttribute('data-x')).toBe('y');
    });

    it('renders boolean true as an empty attribute and removes false/null/undefined', () =>
    {
        const el = h('button', { disabled: true, hidden: false, title: null, lang: undefined });
        expect(el.getAttribute('disabled')).toBe('');
        expect(el.hasAttribute('hidden')).toBe(false);
        expect(el.hasAttribute('title')).toBe(false);
        expect(el.hasAttribute('lang')).toBe(false);
    });

    it('sets DOM-property keys (value, checked, disabled) as live properties, not attributes', () =>
    {
        const input = h('input', { value: 'hello', checked: true, disabled: true }) as HTMLInputElement;
        expect(input.value).toBe('hello');
        expect(input.checked).toBe(true);
        expect(input.disabled).toBe(true);
        // value is a property here, not seeded as an attribute.
        expect(input.hasAttribute('value')).toBe(false);
    });

    it('sets textContent as content rather than an attribute', () =>
    {
        const el = h('p', { textContent: 'literal' });
        expect(el.textContent).toBe('literal');
        expect(el.hasAttribute('textContent')).toBe(false);
    });
});

describe('h — static children', () =>
{
    it('appends element children in order', () =>
    {
        const el = h('ul', {}, h('li', {}, 'a'), h('li', {}, 'b'));
        expect(el.children.length).toBe(2);
        expect(el.children[0].textContent).toBe('a');
        expect(el.children[1].textContent).toBe('b');
    });

    it('renders string and number children as text nodes', () =>
    {
        const el = h('span', {}, 'count: ', 7);
        expect(el.textContent).toBe('count: 7');
        expect(el.childNodes.length).toBe(2);
        expect(el.childNodes[0].nodeType).toBe(3);
    });

    it('flattens array children', () =>
    {
        const el = h('div', {}, [h('b', {}, '1'), h('i', {}, '2')], 'tail');
        expect(el.childNodes.length).toBe(3);
        expect(el.textContent).toBe('12tail');
    });

    it('skips null, undefined, and false children', () =>
    {
        const el = h('div', {}, 'a', null, undefined, false, 'b');
        expect(el.textContent).toBe('ab');
        expect(el.childNodes.length).toBe(2);
    });
});

describe('h — reactive attributes', () =>
{
    it('re-applies a function attribute in place when its signal changes', () =>
    {
        createRoot((dispose) =>
        {
            const [cls, setCls] = createSignal('a');
            const el = h('div', { class: () => cls() });
            expect(el.getAttribute('class')).toBe('a');
            setCls('b');
            expect(el.getAttribute('class')).toBe('b');
            dispose();
        });
    });

    it('removes the attribute when a reactive value becomes false/null', () =>
    {
        createRoot((dispose) =>
        {
            const [on, setOn] = createSignal(true);
            const el = h('div', { 'data-on': () => (on() ? 'yes' : null) });
            expect(el.getAttribute('data-on')).toBe('yes');
            setOn(false);
            expect(el.hasAttribute('data-on')).toBe(false);
            dispose();
        });
    });

    it('updates a reactive DOM property in place', () =>
    {
        createRoot((dispose) =>
        {
            const [v, setV] = createSignal('one');
            const input = h('input', { value: () => v() }) as HTMLInputElement;
            expect(input.value).toBe('one');
            setV('two');
            expect(input.value).toBe('two');
            dispose();
        });
    });
});

describe('h — reactive children', () =>
{
    it('patches a text node in place (no node churn) when a reactive child changes', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            const el = h('span', {}, () => `n=${ n() }`);
            const textNode = el.firstChild;
            expect(el.textContent).toBe('n=0');

            setN(1);
            expect(el.textContent).toBe('n=1');
            // Same Text node mutated, not replaced.
            expect(el.firstChild).toBe(textNode);
            dispose();
        });
    });

    it('renders nothing (empty text) for null/false reactive values', () =>
    {
        createRoot((dispose) =>
        {
            const [show, setShow] = createSignal(true);
            const el = h('div', {}, () => (show() ? 'visible' : null));
            expect(el.textContent).toBe('visible');
            setShow(false);
            expect(el.textContent).toBe('');
            dispose();
        });
    });

    it('swaps a text node for an element node on a type transition and back', () =>
    {
        createRoot((dispose) =>
        {
            const [mode, setMode] = createSignal<'text' | 'el'>('text');
            const el = h('div', {}, () => (mode() === 'text' ? 'plain' : h('strong', {}, 'bold')));
            expect(el.textContent).toBe('plain');
            expect(el.querySelector('strong')).toBeNull();

            setMode('el');
            expect(el.querySelector('strong')).not.toBeNull();
            expect(el.querySelector('strong')!.textContent).toBe('bold');

            setMode('text');
            expect(el.querySelector('strong')).toBeNull();
            expect(el.textContent).toBe('plain');
            dispose();
        });
    });

    it('handles rapid successive updates deterministically', () =>
    {
        createRoot((dispose) =>
        {
            const [n, setN] = createSignal(0);
            const el = h('span', {}, () => String(n()));
            for (let i = 1; i <= 50; i++)
            {
                setN(i);
            }
            expect(el.textContent).toBe('50');
            dispose();
        });
    });

    it('coalesces a batch of writes into one final value', () =>
    {
        createRoot((dispose) =>
        {
            const [a, setA] = createSignal(1);
            const [b, setB] = createSignal(2);
            let runs = 0;
            const el = h('span', {}, () =>
            {
                runs++;
                return `${ a() }-${ b() }`;
            });
            expect(runs).toBe(1);
            batch(() =>
            {
                setA(10);
                setB(20);
            });
            expect(el.textContent).toBe('10-20');
            // One coalesced re-run, not two.
            expect(runs).toBe(2);
            dispose();
        });
    });
});

describe('h — events', () =>
{
    it('binds an on* handler that fires on dispatch', () =>
    {
        const calls: string[] = [];
        const button = h('button', { onClick: () =>
        {
            calls.push('hit');
        } });
        document.body.appendChild(button);
        button.click();
        button.click();
        expect(calls).toEqual(['hit', 'hit']);
        button.remove();
    });

    it('passes the event object to the handler', () =>
    {
        let received: Event | null = null;
        const button = h('button', { onClick: (e: Event) =>
        {
            received = e;
        } });
        document.body.appendChild(button);
        button.click();
        expect(received).not.toBeNull();
        expect(received!.type).toBe('click');
        button.remove();
    });
});

describe('h — refs', () =>
{
    it('assigns the element to a createRef object .current', () =>
    {
        const ref = createRef<HTMLDivElement>();
        const el = h('div', { ref });
        expect(ref.current).toBe(el);
    });

    it('invokes a callback ref with the element', () =>
    {
        let captured: HTMLElement | null = null;
        const el = h('div', { ref: (node: HTMLElement) =>
        {
            captured = node;
        } });
        expect(captured).toBe(el);
    });

    it('never renders ref as an attribute', () =>
    {
        const ref = createRef();
        const el = h('div', { ref });
        expect(el.hasAttribute('ref')).toBe(false);
    });
});
