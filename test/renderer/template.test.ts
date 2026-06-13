// Runtime behavior of the template-clone path: tmpl() instantiation,
// bindHole() reactive and static holes, bindProps() wiring - exercising the
// exact call shapes the compiler's `dom` target emits.

import { describe, it, expect } from 'vitest';
import { createSignal, runInMode, subscriberCount } from '@azerothjs/reactivity';
import { tmpl, bindHole, bindChild, bindProps, h, createRoot } from '@azerothjs/core';

describe('tmpl()', () =>
{
    it('returns a fresh deep clone per call', () =>
    {
        const make = tmpl('<li class="row"><span>x</span></li>');

        const a = make();
        const b = make();

        expect(a).not.toBe(b);
        expect(a.outerHTML).toBe(b.outerHTML);
        expect(a.className).toBe('row');
        expect(a.firstChild?.textContent).toBe('x');
    });

    it('throws in string render mode instead of mis-rendering', () =>
    {
        const make = tmpl('<p>x</p>');
        expect(() => runInMode('string', () => make())).toThrow(/client-only/);
    });
});

describe('bindHole()', () =>
{
    it('binds a reactive hole that updates only its own text node', () =>
    {
        const make = tmpl('<li>Count: <!--$--></li>');
        const [count, setCount] = createSignal(0);

        const li = make();
        // Marker is the second child: text 'Count: ' then the comment.
        bindHole(li.firstChild!.nextSibling!, () => count());

        expect(li.textContent).toBe('Count: 0');
        const staticText = li.firstChild;

        setCount(7);
        expect(li.textContent).toBe('Count: 7');
        // The static text node was never touched.
        expect(li.firstChild).toBe(staticText);
    });

    it('places a static value once', () =>
    {
        const make = tmpl('<li><!--$--></li>');
        const li = make();

        bindHole(li.firstChild!, 'plain');

        expect(li.textContent).toBe('plain');
    });

    it('places an element value', () =>
    {
        const make = tmpl('<div><!--$--></div>');
        const root = make();

        bindHole(root.firstChild!, h('span', {}, 'inner'));

        expect(root.firstChild).toBeInstanceOf(HTMLElement);
        expect(root.textContent).toBe('inner');
    });

    it('releases the hole subscription when the owning root disposes', () =>
    {
        const make = tmpl('<li><!--$--></li>');
        const [count] = createSignal(0);

        const dispose = createRoot((d) =>
        {
            const li = make();
            bindHole(li.firstChild!, () => count());
            return d;
        });

        expect(subscriberCount(count)).toBe(1);
        dispose();
        expect(subscriberCount(count)).toBe(0);
    });
});

describe('bindChild()', () =>
{
    it('appends a reactive sole-child hole without a marker', () =>
    {
        const make = tmpl('<li class="row"><span class="id"></span></li>');
        const [id, setId] = createSignal(1);

        const li = make();
        bindChild(li.firstChild as HTMLElement, () => id());

        expect(li.textContent).toBe('1');
        setId(2);
        expect(li.textContent).toBe('2');
    });

    it('appends a static sole-child value once', () =>
    {
        const make = tmpl('<span></span>');
        const span = make();

        bindChild(span, 'plain');

        expect(span.textContent).toBe('plain');
    });
});

describe('bindProps()', () =>
{
    it('wires events, reactive attributes, and DOM properties', () =>
    {
        const make = tmpl('<button>go</button>');
        const [active, setActive] = createSignal(false);
        let clicks = 0;

        const button = make();
        bindProps(button, {
            class: () => (active() ? 'on' : 'off'),
            onClick: () => clicks++,
            disabled: false
        });

        expect(button.getAttribute('class')).toBe('off');
        setActive(true);
        expect(button.getAttribute('class')).toBe('on');

        // Template-path events are DELEGATED: the element must be in the
        // document for the click to bubble to the shared listener.
        document.body.appendChild(button);
        button.click();
        expect(clicks).toBe(1);
        button.remove();
    });

    it('delegates bubbling events: nested handlers fire inner-to-outer', () =>
    {
        const make = tmpl('<div><button>go</button></div>');
        const order: string[] = [];

        const outer = make();
        const inner = outer.firstChild as HTMLElement;
        bindProps(outer, { onClick: () => order.push('outer') });
        bindProps(inner, { onClick: () => order.push('inner') });

        document.body.appendChild(outer);
        inner.click();
        expect(order).toEqual(['inner', 'outer']);
        outer.remove();
    });

    it('delegated handlers respect stopPropagation', () =>
    {
        const make = tmpl('<div><button>go</button></div>');
        const order: string[] = [];

        const outer = make();
        const inner = outer.firstChild as HTMLElement;
        bindProps(outer, { onClick: () => order.push('outer') });
        bindProps(inner, { onClick: (event: Event) =>
        {
            order.push('inner');
            event.stopPropagation();
        } });

        document.body.appendChild(outer);
        inner.click();
        expect(order).toEqual(['inner']);
        outer.remove();
    });

    it('keeps per-element listeners for non-bubbling event types', () =>
    {
        const make = tmpl('<input>');
        let focused = 0;

        const input = make();
        bindProps(input, { onFocus: () => focused++ });

        // focus does not bubble; the handler must work even detached
        // because it was attached directly to the element.
        input.dispatchEvent(new Event('focus'));
        expect(focused).toBe(1);
    });
});
