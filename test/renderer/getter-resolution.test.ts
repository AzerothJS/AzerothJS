import { describe, it, expect } from 'vitest';
import { createSignal, classList, styleMap, h } from '@azerothjs/core';

// Regression suite for the getter double-wrap bug (DECISIONS.md: "Getter
// resolution"). The compiler wraps a compound/call attribute or child
// expression in `() => (...)` so h() treats it as reactive. When that
// expression ALREADY evaluates to a getter - most importantly classList() and
// styleMap(), which RETURN `() => string` - the wrapper produces a
// getter-returning-a-getter. The renderer must call through to the concrete
// value rather than stringifying the inner function (which used to render
// `() => t("...")` source text into the DOM).
//
// Each case below reproduces the EXACT shape the compiler emits.

describe('reactive prop resolves through nested getters', () =>
{
    it('resolves a `class={classList(...)}` double-wrap (compiler emits `() => (classList(...))`)', () =>
    {
        const [isActive, setIsActive] = createSignal(false);

        // Mirrors compile('<div class={classList({ ... })} />')
        const el = h('div', { class: () => (classList({ 'btn': true, 'btn-active': isActive })) });

        expect(el.getAttribute('class')).toBe('btn');

        setIsActive(true);
        expect(el.getAttribute('class')).toBe('btn btn-active');
    });

    it('resolves a `style={styleMap(...)}` double-wrap (compiler emits `() => (styleMap(...))`)', () =>
    {
        const [color, setColor] = createSignal('red');

        const el = h('div', { style: () => (styleMap({ color, 'font-weight': 'bold' })) });

        expect(el.getAttribute('style')).toBe('color: red; font-weight: bold');

        setColor('blue');
        expect(el.getAttribute('style')).toBe('color: blue; font-weight: bold');
    });

    it('keeps the single-getter working case `value={draft()}` (compiler emits `() => (draft())`)', () =>
    {
        const [draft, setDraft] = createSignal('hi');

        const el = h('input', { value: () => (draft()) }) as HTMLInputElement;

        expect(el.value).toBe('hi');

        setDraft('there');
        expect(el.value).toBe('there');
    });

    it('keeps the single arrow case `class={() => cls()}`', () =>
    {
        const [cls, setCls] = createSignal('a');

        const el = h('div', { class: () => cls() });

        expect(el.getAttribute('class')).toBe('a');

        setCls('b');
        expect(el.getAttribute('class')).toBe('b');
    });

    // Regression: a tag with multiple call/expression children
    // (`<Link>{createIcon()}{t('x')}</Link>`) compiles to
    // `children: () => [() => createIcon(), () => t('x')]` - a getter that
    // resolves to an ARRAY of getters. buildNode's array branch must route each
    // element back through the child pipeline (resolving the inner getters),
    // not `String(item)` them - which rendered `()=>t("x")` source text into the
    // DOM (the live navbar's login/register buttons).
    it('resolves an array of getter children (tag-style multi-child)', () =>
    {
        const [label, setLabel] = createSignal('Login');

        const el = h('div', {}, () => [
            () => h('span', {}, 'icon-'),
            () => label()
        ]);

        expect(el.innerHTML).not.toContain('=>');
        expect(el.textContent).toBe('icon-Login');

        setLabel('Logout');
        expect(el.textContent).toBe('icon-Logout');
    });
});

describe('reactive child resolves through nested getters', () =>
{
    it('renders a getter-returning-a-getter child as text, not function source', () =>
    {
        const title = (): string => 'Hello';

        // Mirrors compile('<h1>{p.title}</h1>') where p.title is `() => string`,
        // which the compiler emits as `() => (p.title)`.
        const el = h('h1', {}, () => (title));

        expect(el.textContent).toBe('Hello');
        expect(el.textContent).not.toContain('=>');
    });

    it('renders a ternary-returning-getter child (compiler emits `() => (cond ? a : b)`)', () =>
    {
        const [flag] = createSignal(true);
        const a = (): string => 'A';
        const b = (): string => 'B';

        const el = h('h1', {}, () => (flag() ? a : b));

        expect(el.textContent).toBe('A');
    });

    it('keeps the plain reactive text child working', () =>
    {
        const [count, setCount] = createSignal(0);

        const el = h('span', {}, () => `Count: ${ count() }`);

        expect(el.textContent).toBe('Count: 0');

        setCount(5);
        expect(el.textContent).toBe('Count: 5');
    });
});
