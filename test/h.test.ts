import { describe, it, expect } from 'vitest';
import { createSignal, h } from '../src';

describe('h()', () =>
{
    it('should create a real DOM element', () =>
    {
        const el = h('div', {});

        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.tagName).toBe('DIV');
    });

    it('should set static attributes', () =>
    {
        const el = h('div', { class: 'box', id: 'main' });

        expect(el.getAttribute('class')).toBe('box');
        expect(el.getAttribute('id')).toBe('main');
    });

    it('should render text children', () =>
    {
        const el = h('p', {}, 'Hello World');

        expect(el.textContent).toBe('Hello World');
    });

    it('should render number children', () =>
    {
        const el = h('span', {}, 42);

        expect(el.textContent).toBe('42');
    });

    it('should render nested elements', () =>
    {
        const el = h('div', {},
            h('p', {}, 'First'),
            h('span', {}, 'Second'),
        );

        expect(el.children.length).toBe(2);
        expect(el.children[0].tagName).toBe('P');
        expect(el.children[0].textContent).toBe('First');
        expect(el.children[1].tagName).toBe('SPAN');
        expect(el.children[1].textContent).toBe('Second');
    });

    it('should handle no children', () =>
    {
        const el = h('br', {});

        expect(el.childNodes.length).toBe(0);
    });

    it('should attach event handlers', () =>
    {
        let clicked = false;
        const el = h('button', { onClick: () => { clicked = true; } }, 'Click');

        el.click();
        expect(clicked).toBe(true);
    });

    it('should handle boolean true attributes', () =>
    {
        const el = h('button', { disabled: true });

        expect(el.hasAttribute('disabled')).toBe(true);
    });

    it('should handle boolean false attributes', () =>
    {
        const el = h('button', { disabled: false });

        expect(el.hasAttribute('disabled')).toBe(false);
    });

    it('should skip null and undefined children', () =>
    {
        const el = h('div', {}, null, 'Hello', undefined, false);

        expect(el.textContent).toBe('Hello');
    });

    it('should render reactive text children', () =>
    {
        const [count, setCount] = createSignal(0);
        const el = h('p', {}, () => `Count: ${count()}`);

        expect(el.textContent).toBe('Count: 0');

        setCount(5);
        expect(el.textContent).toBe('Count: 5');

        setCount(100);
        expect(el.textContent).toBe('Count: 100');
    });

    it('should render reactive attributes', () =>
    {
        const [isActive, setIsActive] = createSignal(false);
        const el = h('div', { class: () => isActive() ? 'active' : 'inactive' });

        expect(el.getAttribute('class')).toBe('inactive');

        setIsActive(true);
        expect(el.getAttribute('class')).toBe('active');
    });

    it('should handle multiple reactive children', () =>
    {
        const [first, setFirst] = createSignal('Hello');
        const [second, setSecond] = createSignal('World');

        const el = h('div', {},
            h('span', {}, () => first()),
            h('span', {}, () => second()),
        );

        expect(el.children[0].textContent).toBe('Hello');
        expect(el.children[1].textContent).toBe('World');

        setFirst('Goodbye');
        expect(el.children[0].textContent).toBe('Goodbye');
        expect(el.children[1].textContent).toBe('World');

        setSecond('Quantum');
        expect(el.children[0].textContent).toBe('Goodbye');
        expect(el.children[1].textContent).toBe('Quantum');
    });

    it('should set value as DOM property for input elements', () =>
    {
        const el = h('input', { value: 'hello' }) as HTMLInputElement;

        expect(el.value).toBe('hello');
    });

    it('should reactively update input value', () =>
    {
        const [text, setText] = createSignal('initial');
        const el = h('input', { value: () => text() }) as HTMLInputElement;

        expect(el.value).toBe('initial');

        setText('updated');
        expect(el.value).toBe('updated');

        setText('');
        expect(el.value).toBe('');
    });

    it('should set checked as DOM property for checkboxes', () =>
    {
        const [checked, setChecked] = createSignal(false);
        const el = h('input', {
            type: 'checkbox',
            checked: () => checked(),
        }) as HTMLInputElement;

        expect(el.checked).toBe(false);

        setChecked(true);
        expect(el.checked).toBe(true);
    });
});
