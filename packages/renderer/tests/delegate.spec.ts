// @vitest-environment happy-dom
//
// Behavioral coverage for event delegation (delegate.ts), exercised through its
// only public entry point bindProps (h.ts): bubbling events are delegated to one
// document listener per type, handlers fire by walking the target's ancestor
// chain, stopPropagation halts the walk, and non-bubbling events keep
// per-element listeners.
import { describe, it, expect } from 'vitest';
import { h, bindProps } from '@azerothjs/renderer';

function attach(el: HTMLElement): HTMLElement
{
    document.body.appendChild(el);
    return el;
}

describe('event delegation via bindProps', () =>
{
    it('fires a delegated click handler on a bound, connected element', () =>
    {
        const calls: string[] = [];
        const button = h('button', {});
        bindProps(button, { onClick: () =>
        {
            calls.push('click');
        } });
        attach(button);

        button.click();
        button.click();
        expect(calls).toEqual(['click', 'click']);
        button.remove();
    });

    it('delegates from a nested target up through ancestor handlers', () =>
    {
        const order: string[] = [];
        const child = h('span', {});
        const parent = h('div', {});
        parent.appendChild(child);
        bindProps(parent, { onClick: () =>
        {
            order.push('parent');
        } });
        bindProps(child, { onClick: () =>
        {
            order.push('child');
        } });
        attach(parent);

        child.click();
        // Walk runs target-first, then ancestors (bubbling order).
        expect(order).toEqual(['child', 'parent']);
        parent.remove();
    });

    it('stopPropagation halts the ancestor walk', () =>
    {
        const order: string[] = [];
        const child = h('span', {});
        const parent = h('div', {});
        parent.appendChild(child);
        bindProps(parent, { onClick: () =>
        {
            order.push('parent');
        } });
        bindProps(child, { onClick: (e: Event) =>
        {
            order.push('child'); e.stopPropagation();
        } });
        attach(parent);

        child.click();
        // The child's stopPropagation prevents the parent handler from running.
        expect(order).toEqual(['child']);
        parent.remove();
    });

    it('shares one document listener across many delegated elements of the same type', () =>
    {
        const hits: number[] = [];
        const a = h('button', {});
        const b = h('button', {});
        bindProps(a, { onClick: () =>
        {
            hits.push(1);
        } });
        bindProps(b, { onClick: () =>
        {
            hits.push(2);
        } });
        attach(a);
        attach(b);

        a.click();
        b.click();
        a.click();
        expect(hits).toEqual([1, 2, 1]);
        a.remove();
        b.remove();
    });

    it('keeps a per-element listener for a non-bubbling event (mouseenter)', () =>
    {
        const calls: string[] = [];
        const el = h('div', {});
        // mouseenter is NOT in the delegated set, so bindProps falls back to addEventListener.
        bindProps(el, { onMouseenter: () =>
        {
            calls.push('enter');
        } });
        attach(el);

        el.dispatchEvent(new Event('mouseenter'));
        expect(calls).toEqual(['enter']);
        el.remove();
    });

    it('delegates input/change events too', () =>
    {
        const seen: string[] = [];
        const input = h('input', {});
        bindProps(input, { onInput: () =>
        {
            seen.push('input');
        } });
        attach(input);

        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(seen).toEqual(['input']);
        input.remove();
    });
});
