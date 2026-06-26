// @vitest-environment happy-dom
//
// Behavioral coverage for Show (show.ts): condition toggle, fallback, lazy
// single-branch construction, branch disposal on swap (no effect leak), and
// preservation of inner reactive state across unrelated re-renders.
import { describe, it, expect } from 'vitest';
import { createSignal, createMemo, createRoot, subscriberCount } from '@azerothjs/reactivity';
import { h, render, Show } from '@azerothjs/renderer';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('Show', () =>
{
    it('renders children when when is true and nothing when false (no fallback)', () =>
    {
        const [on, setOn] = createSignal(true);
        const container = mount(() => h('div', {}, Show({
            when: on,
            children: () => h('p', {}, 'visible')
        })));
        expect(container.querySelector('p')).not.toBeNull();

        setOn(false);
        expect(container.querySelector('p')).toBeNull();
        expect(container.textContent).toBe('');
        container.remove();
    });

    it('swaps between children and fallback on toggle', () =>
    {
        const [on, setOn] = createSignal(false);
        const container = mount(() => h('div', {}, Show({
            when: on,
            fallback: () => h('span', { class: 'fb' }, 'fallback'),
            children: () => h('span', { class: 'main' }, 'main')
        })));
        expect(container.querySelector('.fb')).not.toBeNull();
        expect(container.querySelector('.main')).toBeNull();

        setOn(true);
        expect(container.querySelector('.main')).not.toBeNull();
        expect(container.querySelector('.fb')).toBeNull();

        setOn(false);
        expect(container.querySelector('.fb')).not.toBeNull();
        expect(container.querySelector('.main')).toBeNull();
        container.remove();
    });

    it('builds only the active branch lazily', () =>
    {
        let childBuilds = 0;
        let fallbackBuilds = 0;
        const [on, setOn] = createSignal(true);
        const container = mount(() => h('div', {}, Show({
            when: on,
            fallback: () =>
            {
                fallbackBuilds++; return h('span', {}, 'fb');
            },
            children: () =>
            {
                childBuilds++; return h('span', {}, 'main');
            }
        })));
        expect(childBuilds).toBe(1);
        expect(fallbackBuilds).toBe(0);

        setOn(false);
        expect(fallbackBuilds).toBe(1);
        expect(childBuilds).toBe(1);

        setOn(true);
        // Branch rebuilt on re-entry.
        expect(childBuilds).toBe(2);
        container.remove();
    });

    it('disposes the inactive branch\'s effects on swap (no leak)', () =>
    {
        const [on, setOn] = createSignal(true);
        const [inner, setInner] = createSignal('a');
        const container = mount(() => h('div', {}, Show({
            when: on,
            children: () => h('span', {}, () => inner())
        })));
        // The visible branch reads inner -> one subscriber.
        expect(subscriberCount(inner)).toBe(1);

        setOn(false);
        // Branch torn down: its effect unsubscribed from inner.
        expect(subscriberCount(inner)).toBe(0);
        // Writing inner while hidden does not resurrect anything.
        setInner('b');
        expect(subscriberCount(inner)).toBe(0);
        container.remove();
    });

    it('does not rebuild the branch when a signal read inside it changes', () =>
    {
        const [on] = createSignal(true);
        const [label, setLabel] = createSignal('x');
        let builds = 0;
        const container = mount(() => h('div', {}, Show({
            when: on,
            children: () =>
            {
                builds++;
                return h('span', {}, () => label());
            }
        })));
        expect(builds).toBe(1);
        const span = container.querySelector('span')!;

        setLabel('y');
        // Inner change patches text in place; branch is NOT rebuilt.
        expect(builds).toBe(1);
        expect(container.querySelector('span')).toBe(span);
        expect(span.textContent).toBe('y');
        container.remove();
    });

    it('accepts a thunk-returning getter for when', () =>
    {
        const [count, setCount] = createSignal(0);
        const container = mount(() => h('div', {}, Show({
            when: () => count() > 2,
            children: () => h('p', {}, 'big')
        })));
        expect(container.querySelector('p')).toBeNull();
        setCount(3);
        expect(container.querySelector('p')).not.toBeNull();
        setCount(1);
        expect(container.querySelector('p')).toBeNull();
        container.remove();
    });

    it('re-runs its branch effect on any tracked when change (getter is not memoized)', () =>
    {
        // NOTE: the swap effect tracks whatever `when` reads, not a memoized
        // boolean. A `() => n() > 0` getter therefore re-runs (and rebuilds the
        // active branch) on EVERY change to n, even when the boolean is steady.
        // Wrapping `when` in a createMemo is the way to get flip-only swaps.
        const [n, setN] = createSignal(1);
        let builds = 0;
        const container = mount(() => h('div', {}, Show({
            when: () => n() > 0,
            children: () =>
            {
                builds++; return h('p', {}, 'pos');
            }
        })));
        expect(builds).toBe(1);
        setN(5); // still > 0, but the getter re-runs the effect
        expect(builds).toBe(2);
        setN(10); // still > 0
        expect(builds).toBe(3);
        // The content stays correct regardless of the rebuild.
        expect(container.querySelector('p')!.textContent).toBe('pos');
        container.remove();
    });

    it('with a memoized when, swaps only when the boolean actually flips', () =>
    {
        const [n, setN] = createSignal(1);
        let builds = 0;
        const container = mount(() =>
        {
            const positive = createMemo(() => n() > 0);
            return h('div', {}, Show({
                when: positive,
                children: () =>
                {
                    builds++; return h('p', {}, 'pos');
                }
            }));
        });
        expect(builds).toBe(1);
        setN(5); // memo value unchanged -> no rebuild
        expect(builds).toBe(1);
        setN(-1); // flips false -> branch removed
        expect(builds).toBe(1);
        expect(container.querySelector('p')).toBeNull();
        container.remove();
    });

    it('works as a direct child of a table body (no wrapper element)', () =>
    {
        createRoot((dispose) =>
        {
            const [on] = createSignal(true);
            const tbody = h('tbody', {}, Show({
                when: on,
                children: () => h('tr', {}, h('td', {}, 'cell'))
            }));
            // The <tr> is a direct child of <tbody>, not nested in a span wrapper.
            expect(tbody.querySelector('tbody > tr')).not.toBeNull();
            dispose();
        });
    });

    // Regression: a branch thunk that returns a non-element value (a string, an array) must be
    // coerced to nodes - the same as a reactive hole - not handed straight to insertBefore (which
    // threw "Argument 1 does not implement interface Node", crashing the whole render on refresh).
    describe('non-element branch values', () =>
    {
        // Branches may legitimately return any child type; the props type is widened here for the test.
        const branch = (fn: () => unknown): (() => HTMLElement) => fn as () => HTMLElement;

        it('renders a string children branch as text instead of crashing', () =>
        {
            const [on] = createSignal(true);
            const container = mount(() => h('div', {}, Show({ when: on, children: branch(() => 'just text') })));
            expect(container.textContent).toContain('just text');
            container.remove();
        });

        it('renders a string fallback as text', () =>
        {
            const [on] = createSignal(false);
            const container = mount(() => h('div', {}, Show({
                when: on,
                children: () => h('p', {}, 'x'),
                fallback: branch(() => 'loading')
            })));
            expect(container.textContent).toContain('loading');
            container.remove();
        });

        it('renders an array branch (both nodes, wrapped in a display:contents span)', () =>
        {
            const [on] = createSignal(true);
            const container = mount(() => h('div', {}, Show({
                when: on,
                children: branch(() => [h('span', {}, 'a'), h('span', {}, 'b')])
            })));
            expect(container.textContent).toBe('ab'); // both array items rendered
            container.remove();
        });

        it('renders nothing for a null branch (no stray text node)', () =>
        {
            const [on] = createSignal(true);
            const container = mount(() => h('div', {}, Show({ when: on, children: branch(() => null) })));
            expect(container.textContent).toBe('');
            container.remove();
        });

        it('unwraps a NESTED-thunk branch (markup used as a fallback value) instead of rendering its source', () =>
        {
            // The compiler emits `fallback: () => (() => Show(...))` when markup is used as a prop value
            // (e.g. `fallback={<Show .../>}`). The branch result is then a function, not a node - which
            // previously crashed insertBefore, then (after coercion) rendered the function's SOURCE as
            // text. resolveReactive must unwrap it to the real element.
            const [on] = createSignal(false); // when=false -> render the fallback
            const container = mount(() => h('div', {}, Show({
                when: on,
                children: () => h('p', {}, 'main'),
                fallback: branch(() => () => h('span', { class: 'nested' }, 'fallback-content'))
            })));
            expect(container.querySelector('span.nested')).not.toBeNull();
            expect(container.textContent).toContain('fallback-content');
            expect(container.textContent).not.toContain('=>'); // never the function source
            container.remove();
        });
    });
});
