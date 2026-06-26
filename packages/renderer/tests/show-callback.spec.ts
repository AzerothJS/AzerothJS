// @vitest-environment happy-dom
//
// The <Show> value-callback form: `<Show when={value()}>{(value) => ...}</Show>` passes the children an
// ACCESSOR to the narrowed, non-nullish `when` value. This replaces the snapshot-IIFE pattern
// (`{(() => { const x = thing()!; return ...; })()}`) - the accessor stays reactive, never yields null
// while the branch is mounted, and the branch is NOT rebuilt when the value changes (only on a
// truthy<->falsy flip). The plain thunk form keeps its original contract (see show.spec.ts).
import { describe, it, expect } from 'vitest';
import { createSignal, createEffect, onCleanup, subscriberCount } from '@azerothjs/reactivity';
import { h, render, hydrate, Show } from '@azerothjs/renderer';
import { renderToString } from '@azerothjs/server';

interface User { name: string }

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

function ssrInto(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    container.innerHTML = renderToString(component);
    document.body.appendChild(container);
    return container;
}

describe('Show value-callback', () =>
{
    it('null -> value: builds the callback branch with the narrowed accessor', () =>
    {
        const [user, setUser] = createSignal<User | null>(null);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            fallback: () => h('p', { class: 'fb' }, 'none'),
            children: (u) => h('span', {}, () => u().name)
        })));
        expect(c.querySelector('.fb')).not.toBeNull();
        expect(c.querySelector('span')).toBeNull();

        setUser({ name: 'Ann' });
        expect(c.querySelector('.fb')).toBeNull();
        expect(c.querySelector('span')!.textContent).toBe('Ann');
        c.remove();
    });

    it('value change (stays truthy): updates reactively WITHOUT rebuilding the branch', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        let builds = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                builds++;
                return h('span', {}, () => u().name);
            }
        })));
        const span = c.querySelector('span')!;
        expect(builds).toBe(1);
        expect(span.textContent).toBe('Ann');

        setUser({ name: 'Bob' });
        expect(builds).toBe(1);                 // branch NOT rebuilt
        expect(c.querySelector('span')).toBe(span); // same DOM node (focus/scroll preserved)
        expect(span.textContent).toBe('Bob');   // accessor updated reactively
        c.remove();
    });

    it('value -> null: tears down the branch with NO null-deref (the IIFE-replacement guarantee)', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            // `u().name` would throw if the accessor ever yielded null during teardown.
            children: (u) => h('span', {}, () => u().name)
        })));
        expect(c.querySelector('span')).not.toBeNull();

        expect(() => setUser(null)).not.toThrow();
        expect(c.querySelector('span')).toBeNull();
        expect(c.textContent).toBe('');
        c.remove();
    });

    it('toggling back and forth rebuilds cleanly each time', () =>
    {
        const [user, setUser] = createSignal<User | null>(null);
        let builds = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                builds++; return h('span', {}, () => u().name);
            }
        })));
        expect(builds).toBe(0);
        setUser({ name: 'A' });
        expect(builds).toBe(1);
        setUser(null);
        expect(c.querySelector('span')).toBeNull();
        setUser({ name: 'B' });
        expect(builds).toBe(2);
        expect(c.querySelector('span')!.textContent).toBe('B');
        c.remove();
    });

    it('disposes the branch effects on teardown (no leak)', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const [tick] = createSignal(0);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) => h('span', {}, () =>
            {
                tick(); // subscribe an inner effect to `tick`
                return u().name;
            })
        })));
        expect(subscriberCount(tick)).toBe(1);
        setUser(null);                       // tear the branch down
        expect(subscriberCount(tick)).toBe(0); // its effects unsubscribed
        c.remove();
    });

    it('onCleanup inside the callback branch runs on teardown', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        let cleaned = 0;
        const c = mount(() => h('div', {}, Show<User | null>({
            when: user,
            children: (u) =>
            {
                createEffect(() =>
                {
                    onCleanup(() =>
                    {
                        cleaned++;
                    });
                });
                return h('span', {}, () => u().name);
            }
        })));
        expect(cleaned).toBe(0);
        setUser(null);
        expect(cleaned).toBe(1);
        c.remove();
    });

    it('nested value-callback Shows narrow independently', () =>
    {
        const [outer, setOuter] = createSignal<User | null>({ name: 'Out' });
        const [inner, setInner] = createSignal<User | null>(null);
        const c = mount(() => h('div', {}, Show<User | null>({
            when: outer,
            children: (o) => h('section', {},
                h('h1', {}, () => o().name),
                Show<User | null>({
                    when: inner,
                    children: (i) => h('span', { class: 'inner' }, () => `${ o().name }/${ i().name }`)
                })
            )
        })));
        expect(c.querySelector('h1')!.textContent).toBe('Out');
        expect(c.querySelector('.inner')).toBeNull();

        setInner({ name: 'In' });
        expect(c.querySelector('.inner')!.textContent).toBe('Out/In');

        setOuter({ name: 'Out2' });
        expect(c.querySelector('.inner')!.textContent).toBe('Out2/In'); // both accessors reactive, no rebuild
        c.remove();
    });

    it('a plain thunk child still works alongside the callback form (backward compatible)', () =>
    {
        const [on, setOn] = createSignal(true);
        const c = mount(() => h('div', {}, Show({
            when: on,
            children: () => h('p', {}, 'plain')   // arity-0 thunk: ignores the accessor
        })));
        expect(c.querySelector('p')!.textContent).toBe('plain');
        setOn(false);
        expect(c.querySelector('p')).toBeNull();
        c.remove();
    });

    it('SSR: serializes the callback branch with the evaluated value', () =>
    {
        const App = (): HTMLElement => h('div', {}, Show<User | null>({
            when: () => ({ name: 'Server' }) as User | null,
            children: (u) => h('span', {}, () => u().name)
        }));
        const html = renderToString(App);
        expect(html).toContain('Server');
    });

    it('hydration: adopts the server callback branch, then stays reactive', () =>
    {
        const [user, setUser] = createSignal<User | null>({ name: 'Ann' });
        const App = (): HTMLElement => h('div', {}, Show<User | null>({
            when: user,
            children: (u) => h('span', {}, () => u().name)
        }));
        const container = ssrInto(App);
        const serverSpan = container.querySelector('span')!;
        expect(serverSpan.textContent).toBe('Ann');

        hydrate(App, container);
        expect(container.querySelector('span')).toBe(serverSpan); // adopted, not rebuilt

        setUser({ name: 'Bob' });
        expect(container.querySelector('span')!.textContent).toBe('Bob'); // reactive after hydrate
        container.remove();
    });
});
