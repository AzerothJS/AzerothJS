// @vitest-environment happy-dom
//
// Behavioral coverage for Suspense (suspense.ts): shows the fallback while any
// watched resource loads and the children once all settle, coordinates multiple
// resources, and treats an empty `on` list as "always children". Uses real
// createResource with real promises (no mocked async).
import { describe, it, expect } from 'vitest';
import { createResource, createRoot, type Resource } from '@azerothjs/reactivity';
import { h, render, Suspense } from '@azerothjs/renderer';

// Flush microtasks + a macrotask so a resource's fetcher promise settles.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('Suspense', () =>
{
    it('shows the fallback while a resource is loading, then the children', async () =>
    {
        const container = makeContainer();
        let resource!: Resource<string>;
        createRoot(() =>
        {
            resource = createResource(async () => 'ready');
            render(() => h('div', {}, Suspense({
                on: [resource],
                fallback: () => h('p', { class: 'spinner' }, 'Loading...'),
                children: () => h('p', { class: 'content' }, () => resource.data() ?? '')
            })), container);
        });
        // Initially loading -> fallback.
        expect(container.querySelector('.spinner')).not.toBeNull();
        expect(container.querySelector('.content')).toBeNull();

        await flush();

        // Settled -> children, fallback gone.
        expect(container.querySelector('.content')).not.toBeNull();
        expect(container.querySelector('.content')!.textContent).toBe('ready');
        expect(container.querySelector('.spinner')).toBeNull();
        container.remove();
    });

    it('keeps the fallback until ALL watched resources settle', async () =>
    {
        const container = makeContainer();
        let fast!: Resource<string>;
        let slow!: Resource<string>;
        createRoot(() =>
        {
            fast = createResource(async () => 'fast');
            slow = createResource(async () => new Promise<string>((resolve) =>
            {
                setTimeout(() => resolve('slow'), 30);
            }));
            render(() => h('div', {}, Suspense({
                on: [fast, slow],
                fallback: () => h('p', { class: 'spinner' }, 'Loading...'),
                children: () => h('p', { class: 'content' }, 'all done')
            })), container);
        });
        expect(container.querySelector('.spinner')).not.toBeNull();

        // After the fast one settles, the slow one is still loading -> fallback.
        await flush();
        expect(container.querySelector('.content')).toBeNull();
        expect(container.querySelector('.spinner')).not.toBeNull();

        // Once the slow one settles too, children appear.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(container.querySelector('.content')).not.toBeNull();
        expect(container.querySelector('.spinner')).toBeNull();
        container.remove();
    });

    it('renders children immediately for an empty resource list', () =>
    {
        const container = makeContainer();
        createRoot(() =>
        {
            render(() => h('div', {}, Suspense({
                on: [],
                fallback: () => h('p', { class: 'spinner' }, 'Loading...'),
                children: () => h('p', { class: 'content' }, 'instant')
            })), container);
        });
        expect(container.querySelector('.content')).not.toBeNull();
        expect(container.querySelector('.spinner')).toBeNull();
        container.remove();
    });

    it('swaps back to the fallback when a resource refetches', async () =>
    {
        const container = makeContainer();
        let resource!: Resource<string>;
        createRoot(() =>
        {
            resource = createResource(async () => 'v');
            render(() => h('div', {}, Suspense({
                on: [resource],
                fallback: () => h('p', { class: 'spinner' }, 'Loading...'),
                children: () => h('p', { class: 'content' }, 'loaded')
            })), container);
        });
        await flush();
        expect(container.querySelector('.content')).not.toBeNull();

        // Refetch flips loading back to true -> fallback returns.
        resource.refetch();
        expect(container.querySelector('.spinner')).not.toBeNull();
        expect(container.querySelector('.content')).toBeNull();

        await flush();
        expect(container.querySelector('.content')).not.toBeNull();
        container.remove();
    });
});
