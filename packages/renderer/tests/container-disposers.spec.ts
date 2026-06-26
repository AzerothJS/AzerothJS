// @vitest-environment happy-dom
//
// Behavioral coverage for the container-disposer bookkeeping (container-disposers.ts),
// exercised through its only consumers render() and hydrate(): a per-container
// disposer is recorded on mount and run (then replaced) on the next mount of the
// SAME container, so render <-> hydrate can dispose each other's mount with no
// effect leaks across remounts.
import { describe, it, expect } from 'vitest';
import { createSignal, subscriberCount } from '@azerothjs/reactivity';
import { h, render, hydrate } from '@azerothjs/renderer';
import { renderToString } from '@azerothjs/server';

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('container disposers', () =>
{
    it('disposes the previous render mount when the same container is re-rendered', () =>
    {
        const container = makeContainer();
        const [n, setN] = createSignal(0);
        render(() => h('span', {}, () => `${ n() }`), container);
        expect(subscriberCount(n)).toBe(1);

        render(() => h('span', {}, 'static'), container);
        // First mount's subscription was torn down by its recorded disposer.
        expect(subscriberCount(n)).toBe(0);
        setN(1);
        expect(container.textContent).toBe('static');
        container.remove();
    });

    it('lets hydrate() dispose a prior render() mount on the same container', () =>
    {
        const container = makeContainer();
        const [n, setN] = createSignal(0);
        render(() => h('span', {}, () => `${ n() }`), container);
        expect(subscriberCount(n)).toBe(1);

        const App = (): HTMLElement => h('span', {}, 'hydrated');
        container.innerHTML = renderToString(App);
        hydrate(App, container);
        // The render mount's disposer ran -> its subscription is gone.
        expect(subscriberCount(n)).toBe(0);
        setN(2);
        expect(container.textContent).toBe('hydrated');
        container.remove();
    });

    it('lets render() dispose a prior hydrate() mount on the same container', () =>
    {
        const container = makeContainer();
        const [n, setN] = createSignal(0);
        const App = (): HTMLElement => h('span', {}, () => `${ n() }`);
        container.innerHTML = renderToString(App);
        hydrate(App, container);
        // Hydrated effect is live.
        setN(1);
        expect(container.textContent).toBe('1');
        expect(subscriberCount(n)).toBe(1);

        render(() => h('span', {}, 'rendered'), container);
        // The hydrate mount's disposer ran.
        expect(subscriberCount(n)).toBe(0);
        setN(9);
        expect(container.textContent).toBe('rendered');
        container.remove();
    });

    it('keeps disposers independent per container', () =>
    {
        const a = makeContainer();
        const b = makeContainer();
        const [x] = createSignal(0);
        const [y, setY] = createSignal(0);
        render(() => h('span', {}, () => `${ x() }`), a);
        render(() => h('span', {}, () => `${ y() }`), b);
        expect(subscriberCount(x)).toBe(1);
        expect(subscriberCount(y)).toBe(1);

        // Re-rendering A must not affect B's mount.
        render(() => h('span', {}, 'a2'), a);
        expect(subscriberCount(x)).toBe(0);
        expect(subscriberCount(y)).toBe(1);
        setY(5);
        expect(b.textContent).toBe('5');
        a.remove();
        b.remove();
    });
});
