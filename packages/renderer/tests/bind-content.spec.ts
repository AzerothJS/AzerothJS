// @vitest-environment happy-dom
//
// Regression: an only-child hole receiving a component-children THUNK (the
// compiler wraps component children as `() => element` factories) must RESOLVE
// the chain and render the tree - the bug shipped in 0.9.0-beta.1 stringified
// the function and printed its source text into the page (caught by Guardian's
// <Screen>{ props.children }</Screen>). bindContent must match driveHoleRange's
// resolveReactive semantics and its subtree root ownership.
import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { bindContent, h } from '@azerothjs/renderer';

function host(): HTMLElement
{
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
}

describe('bindContent - thunk resolution', () =>
{
    it('resolves a children THUNK to its element instead of printing source text', () =>
    {
        const el = host();
        const children = (): HTMLElement => h('p', { class: 'inner' }, 'hello');
        // The compiled shape: bindContent(_n, () => (props.children)) where
        // props.children is itself a function.
        bindContent(el, () => children);
        expect(el.querySelector('.inner')?.textContent).toBe('hello');
        expect(el.textContent).not.toContain('=>');
        el.remove();
    });

    it('resolves deeper chains the way resolveReactive does', () =>
    {
        const el = host();
        bindContent(el, () => () => () => h('span', { class: 'deep' }, 'x'));
        expect(el.querySelector('.deep')).not.toBeNull();
        el.remove();
    });

    it('a reactive scalar hole still reuses one text node across updates', () =>
    {
        const el = host();
        const [n, setN] = createSignal(1);
        bindContent(el, () => n());
        const node = el.firstChild;
        expect(el.textContent).toBe('1');
        setN(2);
        expect(el.textContent).toBe('2');
        expect(el.firstChild).toBe(node);
        el.remove();
    });

    it('a hole swapping between scalar and element keeps working in both directions', () =>
    {
        const el = host();
        const [mode, setMode] = createSignal<'text' | 'el'>('text');
        bindContent(el, () => (mode() === 'text' ? 'plain' : () => h('b', { class: 'bold' }, 'built')));
        expect(el.textContent).toBe('plain');
        setMode('el');
        expect(el.querySelector('.bold')?.textContent).toBe('built');
        setMode('text');
        expect(el.textContent).toBe('plain');
        expect(el.querySelector('.bold')).toBeNull();
        el.remove();
    });

    it('a built subtree keeps its own reactivity alive', () =>
    {
        const el = host();
        const [label, setLabel] = createSignal('a');
        bindContent(el, () => () => h('p', { class: 'live' }, () => label()));
        expect(el.querySelector('.live')?.textContent).toBe('a');
        setLabel('b');
        expect(el.querySelector('.live')?.textContent).toBe('b');
        el.remove();
    });
});
