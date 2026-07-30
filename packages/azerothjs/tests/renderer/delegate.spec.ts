// @vitest-environment happy-dom
//
// Behavioral coverage for event delegation (delegate.ts), exercised through its
// only public entry point bindProps (h.ts): bubbling events are delegated to one
// document listener per type, handlers fire by walking the target's ancestor
// chain, stopPropagation halts the walk, and non-bubbling events keep
// per-element listeners.
import { describe, it, expect } from 'vitest';
import { h, destroyComponent } from 'azerothjs';
import { bindProps } from 'azerothjs/internal';

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

    it('snapshots the ancestor chain so a handler removing its node does not truncate the walk', () =>
    {
        const order: string[] = [];
        const list = h('ul', {});
        const row = h('li', {});
        const button = h('button', {});
        row.appendChild(button);
        list.appendChild(row);
        bindProps(list, { onClick: () =>
        {
            order.push('list');
        } });
        // The row handler removes its own node mid-dispatch. Native dispatch computed the
        // path up front, so the list handler still fires; reading parentNode after the fact
        // would find null and skip every ancestor.
        bindProps(row, { onClick: () =>
        {
            order.push('row'); row.remove();
        } });
        bindProps(button, { onClick: () =>
        {
            order.push('button');
        } });
        attach(list);

        button.click();
        expect(order).toEqual(['button', 'row', 'list']);
        list.remove();
    });

    it('stopImmediatePropagation halts the walk (even where cancelBubble is not set for it)', () =>
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
            order.push('child'); e.stopImmediatePropagation();
        } });
        attach(parent);

        child.click();
        expect(order).toEqual(['child']);
        parent.remove();
    });

    it('clears the delegated handler on destroyComponent so a re-inserted node does not fire the old one', () =>
    {
        let calls = 0;
        const button = h('button', {});
        bindProps(button, { onClick: () =>
        {
            calls++;
        } });
        attach(button);

        button.click();
        expect(calls).toBe(1);

        // Teardown + re-insert: without clearing the type Symbol, the document listener would
        // fire the stale handler (with its old captured scope) again.
        button.remove();
        destroyComponent(button);
        attach(button);

        button.click();
        expect(calls).toBe(1);
        button.remove();
    });
});
