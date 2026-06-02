import { describe, it, expect } from 'vitest';
import { createRoot, createResource } from '@azerothjs/core';
import { Suspense } from '../../packages/renderer/src/suspense.ts';

// Helpers

function makeDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    }
{
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) =>
    {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void>
{
    for (let i = 0; i < 4; i++)
    {
        await Promise.resolve();
    }
}

function makeFallback(): () => HTMLElement
{
    return () =>
    {
        const p = document.createElement('p');
        p.setAttribute('data-role', 'fallback');
        p.textContent = 'loading';
        return p;
    };
}

function makeChildren(label: string): () => HTMLElement
{
    return () =>
    {
        const div = document.createElement('div');
        div.setAttribute('data-role', 'children');
        div.textContent = label;
        return div;
    };
}

describe('<Suspense>', () =>
{
    it('renders children when on: is an empty array (degenerate case)', () =>
    {
        createRoot((dispose) =>
        {
            const container = Suspense({
                fallback: makeFallback(),
                on: [],
                children: makeChildren('hello')
            });

            // No resources to wait on -> children shown immediately.
            expect(container.querySelector('[data-role="children"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();
            expect(container.textContent).toBe('hello');

            dispose();
        });
    });

    it('renders children when none of the watched resources are loading', async () =>
    {
        await createRoot(async (dispose) =>
        {
            // Use an immediately-resolving fetcher so the resource
            // settles on the next microtask flush.
            const resource = createResource(async () => 'done');
            await flush();
            // Sanity: resource has settled.
            expect(resource.loading()).toBe(false);

            const container = Suspense({
                fallback: makeFallback(),
                on: [resource],
                children: makeChildren('ok')
            });

            expect(container.querySelector('[data-role="children"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();

            dispose();
        });
    });

    it('renders fallback while a resource is loading and swaps when it settles', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const deferred = makeDeferred<string>();
            const resource = createResource(() => deferred.promise);

            const container = Suspense({
                fallback: makeFallback(),
                on: [resource],
                children: makeChildren('loaded')
            });

            // Loading at construction -> fallback.
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();
            expect(container.querySelector('[data-role="children"]')).toBeNull();

            deferred.resolve('value');
            await flush();

            // Resource settled -> children.
            expect(container.querySelector('[data-role="children"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();
            expect(container.textContent).toBe('loaded');

            dispose();
        });
    });

    it('renders fallback when ANY of multiple resources is loading', () =>
    {
        createRoot((dispose) =>
        {
            // First resource settled, second still pending - Suspense
            // must show the fallback because ANY is enough.
            const settledDeferred = makeDeferred<string>();
            const pendingDeferred = makeDeferred<string>();
            const settled = createResource(() => settledDeferred.promise);
            const pending = createResource(() => pendingDeferred.promise);

            settledDeferred.resolve('a');
            // No flush yet - both still loading at this snapshot.

            const container = Suspense({
                fallback: makeFallback(),
                on: [settled, pending],
                children: makeChildren('all-done')
            });

            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();
            expect(container.querySelector('[data-role="children"]')).toBeNull();

            dispose();
        });
    });

    it('swaps to children only when the LAST loading resource settles', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const dA = makeDeferred<string>();
            const dB = makeDeferred<string>();
            const a = createResource(() => dA.promise);
            const b = createResource(() => dB.promise);

            const container = Suspense({
                fallback: makeFallback(),
                on: [a, b],
                children: makeChildren('all-done')
            });

            // Both pending -> fallback.
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();

            // Resolve only A. B still pending -> still fallback.
            dA.resolve('a');
            await flush();
            expect(container.querySelector('[data-role="fallback"]')).not.toBeNull();
            expect(container.querySelector('[data-role="children"]')).toBeNull();

            // Resolve B -> all settled -> swap.
            dB.resolve('b');
            await flush();
            expect(container.querySelector('[data-role="children"]')).not.toBeNull();
            expect(container.querySelector('[data-role="fallback"]')).toBeNull();
            expect(container.textContent).toBe('all-done');

            dispose();
        });
    });
});
