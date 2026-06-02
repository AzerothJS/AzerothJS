import { describe, it, expect, vi } from 'vitest';
import { createSignal, createRef, h } from '@azerothjs/core';

describe('h()', () =>
{
    it('should create an element with the correct tag', () =>
    {
        const el = h('div', {});
        expect(el.tagName).toBe('DIV');
    });

    it('should set static attributes', () =>
    {
        const el = h('a', { href: 'https://example.com', class: 'link' });
        expect(el.getAttribute('href')).toBe('https://example.com');
        expect(el.getAttribute('class')).toBe('link');
    });

    it('should add event listeners', () =>
    {
        const handler = vi.fn();
        const el = h('button', { onClick: handler });

        el.click();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should append text children', () =>
    {
        const el = h('p', {}, 'Hello, World!');
        expect(el.textContent).toBe('Hello, World!');
    });

    it('should append number children', () =>
    {
        const el = h('span', {}, 42);
        expect(el.textContent).toBe('42');
    });

    it('should append element children', () =>
    {
        const el = h('div', {},
            h('span', {}, 'child')
        );

        expect(el.children.length).toBe(1);
        expect(el.children[0].tagName).toBe('SPAN');
        expect(el.children[0].textContent).toBe('child');
    });

    it('should skip null/undefined/false children', () =>
    {
        const el = h('div', {},
            'visible',
            null,
            undefined,
            false,
            'also visible'
        );

        expect(el.textContent).toBe('visiblealso visible');
    });

    it('should handle reactive text children', () =>
    {
        const [count, setCount] = createSignal(0);

        const el = h('span', {}, () => `Count: ${ count() }`);
        expect(el.textContent).toBe('Count: 0');

        setCount(5);
        expect(el.textContent).toBe('Count: 5');
    });

    it('should update reactive text in place, reusing the same node', () =>
    {
        const [count, setCount] = createSignal(0);

        const el = h('span', {}, () => `Count: ${ count() }`);
        const node = el.firstChild;
        expect(node).not.toBeNull();
        expect(node?.textContent).toBe('Count: 0');

        setCount(5);
        // The primitive fast path must mutate the SAME text node,
        // not build a replacement - no DOM node churn per tick.
        expect(el.firstChild).toBe(node);
        expect(node?.textContent).toBe('Count: 5');
    });

    it('should swap correctly between text and element reactive children', () =>
    {
        const [mode, setMode] = createSignal<'text' | 'el'>('text');

        const el = h('div', {}, () =>
            mode() === 'text' ? 'plain' : h('b', {}, 'bold')
        );

        expect(el.textContent).toBe('plain');
        expect(el.querySelector('b')).toBeNull();

        // text -> element takes the full rebuild path.
        setMode('el');
        expect(el.querySelector('b')?.textContent).toBe('bold');

        // element -> text rebuilds again, then resumes in-place.
        setMode('text');
        expect(el.textContent).toBe('plain');
        expect(el.querySelector('b')).toBeNull();
    });

    it('should assign a ref object to the created element', () =>
    {
        const ref = createRef<HTMLInputElement>();

        const el = h('input', { type: 'text', ref });

        expect(ref.current).toBe(el);
        // `ref` must never leak into the DOM as an attribute.
        expect(el.hasAttribute('ref')).toBe(false);
    });

    it('should call a ref callback with the created element', () =>
    {
        let captured: HTMLElement | null = null;

        const el = h('div', { ref: (node: HTMLElement) =>
        {
            captured = node;
        } });

        expect(captured).toBe(el);
        expect(el.hasAttribute('ref')).toBe(false);
    });

    it('should handle reactive attributes', () =>
    {
        const [cls, setCls] = createSignal('off');

        const el = h('div', { class: () => cls() });
        expect(el.getAttribute('class')).toBe('off');

        setCls('on');
        expect(el.getAttribute('class')).toBe('on');
    });

    it('should set DOM properties', () =>
    {
        const el = h('input', {
            type: 'text',
            value: 'hello'
        }) as HTMLInputElement;

        expect(el.value).toBe('hello');
    });

    it('should handle boolean attributes (true)', () =>
    {
        const el = h('button', { disabled: true });
        expect(el.hasAttribute('disabled')).toBe(true);
    });

    it('should handle boolean attributes (false)', () =>
    {
        const el = h('button', { disabled: false });
        expect(el.hasAttribute('disabled')).toBe(false);
    });

    it('should handle reactive boolean attributes', () =>
    {
        const [disabled, setDisabled] = createSignal(false);

        const el = h('button', { disabled: () => disabled() });
        expect(el.hasAttribute('disabled')).toBe(false);

        setDisabled(true);
        expect(el.hasAttribute('disabled')).toBe(true);
    });

    it('should flatten array children', () =>
    {
        const items = ['Apple', 'Banana', 'Cherry'];
        const el = h('ul', {},
            items.map(item => h('li', {}, item))
        );

        expect(el.children.length).toBe(3);
        expect(el.children[0].textContent).toBe('Apple');
        expect(el.children[1].textContent).toBe('Banana');
        expect(el.children[2].textContent).toBe('Cherry');
    });

    it('should handle nested array children', () =>
    {
        const el = h('div', {},
            h('h1', {}, 'Title'),
            ['a', 'b', 'c'].map(s => h('p', {}, s)),
            h('footer', {}, 'End')
        );

        expect(el.children.length).toBe(5);
        expect(el.children[0].textContent).toBe('Title');
        expect(el.children[4].textContent).toBe('End');
    });

    it('should handle multiple children types', () =>
    {
        const [name] = createSignal('World');

        const el = h('div', {},
            'Hello, ',
            () => name(),
            '!',
            h('br', {}),
            42
        );

        expect(el.childNodes.length).toBe(5);
    });
});
