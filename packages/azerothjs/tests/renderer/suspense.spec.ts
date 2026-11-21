// @vitest-environment happy-dom
//
// Behavioral coverage for Suspense (suspense.ts): shows the fallback while any
// watched resource loads and the children once all settle, coordinates multiple
// resources, and treats an empty `on` list as "always children". Uses real
// createResource with real promises (no mocked async).
import { describe, it, expect } from 'vitest';
import { createResource, createRoot, createSignal, type Resource, h, render, Suspense } from 'azerothjs';
import { GatedServer } from '../support/gated-cart.ts';

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

    it('keeps the typed input on an equal-key update and a warm refetch, then shows the fallback for a new key', async () =>
    {
        const container = makeContainer();
        const server = new GatedServer(1);
        const [user, setUser] = createSignal({ id: 1, name: 'before' });
        const [resource, dispose] = createRoot(d =>
        {
            const view = createResource(() => user().id, (_id, signal) => server.get(signal));
            render(() => h('div', {}, Suspense({
                on: [view],
                fallback: () => h('p', { class: 'spinner' }, 'Loading...'),
                children: () => h('input', {})
            })), container);
            return [view, d] as const;
        });
        try
        {
            expect(container.querySelector('.spinner')).not.toBeNull();
            await server.releaseGet(0);
            const input = container.querySelector('input')!;
            input.value = 'unsaved draft';
            setUser({ id: 1, name: 'renamed' });
            expect(container.querySelector('input')).toBe(input);
            expect(server.gets).toHaveLength(1);
            const refreshed = resource.refetch();
            expect(container.querySelector('.spinner')).toBeNull();
            expect(container.querySelector('input')).toBe(input);
            await server.releaseGet(1);
            await refreshed;
            expect(container.querySelector('input')?.value).toBe('unsaved draft');
            setUser({ id: 2, name: 'next user' });
            expect(container.querySelector('.spinner')).not.toBeNull();
            expect(container.querySelector('input')).toBeNull();
            expect(resource.data()).toBeUndefined();
            await server.releaseGet(2);
            expect(container.querySelector('input')).not.toBe(input);
            expect(container.querySelector('input')?.value).toBe('');
        }
        finally
        {
            dispose();
            container.remove();
        }
    });
});
