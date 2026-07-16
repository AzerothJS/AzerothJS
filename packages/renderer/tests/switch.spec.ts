// @vitest-environment happy-dom
//
// Behavioral coverage for Switch/Match (switch.ts): first-match-wins selection,
// priority ordering, fallback, reactive case swapping, single-branch mounting,
// and branch disposal on swap (no leak).
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, subscriberCount } from '@azerothjs/reactivity';
import { h, render, Switch, Match } from '@azerothjs/renderer';

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('Match', () =>
{
    it('builds a normalized case with a lazy when and a render thunk', () =>
    {
        const [n] = createSignal(5);
        const c = Match({ when: () => n() > 0, children: () => h('p', {}, 'pos') });
        expect(typeof c.when).toBe('function');
        expect(typeof c.render).toBe('function');
        expect(c.when()).toBe(true);
    });
});

describe('Switch', () =>
{
    it('renders the first matching case', () =>
    {
        const [status, setStatus] = createSignal('loading');
        const container = mount(() => h('div', {}, Switch({
            children: [
                Match({ when: () => status() === 'loading', children: () => h('p', { class: 'l' }, 'Loading') }),
                Match({ when: () => status() === 'error', children: () => h('p', { class: 'e' }, 'Error') })
            ]
        })));
        expect(container.querySelector('.l')).not.toBeNull();
        expect(container.querySelector('.e')).toBeNull();

        setStatus('error');
        expect(container.querySelector('.e')).not.toBeNull();
        expect(container.querySelector('.l')).toBeNull();
        container.remove();
    });

    it('honours priority order: an earlier case wins over a later one', () =>
    {
        const [flag] = createSignal(true);
        const container = mount(() => h('div', {}, Switch({
            children: [
                Match({ when: () => flag(), children: () => h('p', { class: 'first' }, 'first') }),
                Match({ when: () => flag(), children: () => h('p', { class: 'second' }, 'second') })
            ]
        })));
        expect(container.querySelector('.first')).not.toBeNull();
        expect(container.querySelector('.second')).toBeNull();
        container.remove();
    });

    it('renders the fallback when no case matches', () =>
    {
        const [status, setStatus] = createSignal('idle');
        const container = mount(() => h('div', {}, Switch({
            fallback: () => h('p', { class: 'fb' }, 'Idle'),
            children: [
                Match({ when: () => status() === 'loading', children: () => h('p', { class: 'l' }, 'Loading') })
            ]
        })));
        expect(container.querySelector('.fb')).not.toBeNull();

        setStatus('loading');
        expect(container.querySelector('.l')).not.toBeNull();
        expect(container.querySelector('.fb')).toBeNull();

        setStatus('idle');
        expect(container.querySelector('.fb')).not.toBeNull();
        container.remove();
    });

    it('renders nothing when no case matches and there is no fallback', () =>
    {
        const [status] = createSignal('idle');
        const container = mount(() => h('div', {}, Switch({
            children: [
                Match({ when: () => status() === 'on', children: () => h('p', {}, 'On') })
            ]
        })));
        expect(container.textContent).toBe('');
        container.remove();
    });

    it('mounts only the winning case and disposes the loser on swap', () =>
    {
        const [which, setWhich] = createSignal('a');
        const [aSig] = createSignal('A-content');
        let aBuilds = 0;
        let bBuilds = 0;
        const container = mount(() => h('div', {}, Switch({
            children: [
                Match({ when: () => which() === 'a', children: () =>
                {
                    aBuilds++; return h('p', { class: 'a' }, () => aSig());
                } }),
                Match({ when: () => which() === 'b', children: () =>
                {
                    bBuilds++; return h('p', { class: 'b' }, 'B');
                } })
            ]
        })));
        expect(aBuilds).toBe(1);
        expect(bBuilds).toBe(0);
        // Case A reads aSig -> 1 subscriber.
        expect(subscriberCount(aSig)).toBe(1);

        setWhich('b');
        expect(bBuilds).toBe(1);
        // Case A torn down -> its subscription is gone.
        expect(subscriberCount(aSig)).toBe(0);
        expect(container.querySelector('.b')).not.toBeNull();
        expect(container.querySelector('.a')).toBeNull();
        container.remove();
    });

    it('accepts a thunk returning the case array', () =>
    {
        const [status, setStatus] = createSignal('one');
        const container = mount(() => h('div', {}, Switch({
            children: () => [
                Match({ when: () => status() === 'one', children: () => h('p', { class: 'one' }, '1') }),
                Match({ when: () => status() === 'two', children: () => h('p', { class: 'two' }, '2') })
            ]
        })));
        expect(container.querySelector('.one')).not.toBeNull();
        setStatus('two');
        expect(container.querySelector('.two')).not.toBeNull();
        container.remove();
    });

    it('matches on any TRUTHY when value, like Show (objects, strings, null)', () =>
    {
        const [user, setUser] = createSignal<{ name: string } | null>(null);
        const container = mount(() => h('div', {}, Switch({
            children: [
                // `when` is an object-or-null accessor - no boolean coercion required.
                Match({ when: () => user(), children: () => h('p', { class: 'user' }, 'hi') }),
                Match({ when: 'always truthy', children: () => h('p', { class: 'fallback-ish' }, 'anon') })
            ]
        })));
        expect(container.querySelector('.user')).toBeNull();
        expect(container.querySelector('.fallback-ish')).not.toBeNull();
        setUser({ name: 'thrall' });
        expect(container.querySelector('.user')).not.toBeNull();
        expect(container.querySelector('.fallback-ish')).toBeNull();
        container.remove();
    });

    it('works directly inside a select element (no wrapper)', () =>
    {
        createRoot((dispose) =>
        {
            const [on] = createSignal(true);
            const select = h('select', {}, Switch({
                children: [
                    Match({ when: () => on(), children: () => h('option', { value: 'x' }, 'X') })
                ]
            }));
            expect(select.querySelector('select > option')).not.toBeNull();
            dispose();
        });
    });
});
