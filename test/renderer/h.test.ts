import { describe, it, expect, vi } from 'vitest';
import { createSignal, h } from '../../src';

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
