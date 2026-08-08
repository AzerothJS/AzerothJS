// Hydration AFTER streaming (happy-dom): the swapped DOM adopts node-for-node with zero
// mismatches and zero refetches, because the chunk seeds land under the same scoped-ordinal
// ids the client re-derives. The swap function under test is the REAL azsRuntime - the same
// code browsers execute - applied chunk by chunk exactly as the wire would.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Show, Suspense, createResource, createSignal, h, hydrate, renderToStream } from 'azerothjs';
import { azsRuntime } from '../../src/renderer/stream-swap.ts';

interface AzsGlobal
{
    __AZS_S?: Record<string, unknown>;
    __AZS?: (id: number) => void;
}

async function streamAll(stream: ReadableStream<Uint8Array>): Promise<string[]>
{
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = stream.getReader();
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks;
}

/** Applies one wire chunk the way a browser would: inert insert, then the swap call. */
function applyChunk(container: HTMLElement, chunk: string): void
{
    const holder = document.createElement('div');
    holder.innerHTML = chunk.replace(/<script>[^]*?<\/script>/g, '');
    while (holder.firstChild !== null)
    {
        container.appendChild(holder.firstChild);
    }
    const call = /__AZS\((\d+)\)/.exec(chunk);
    if (call !== null)
    {
        ((globalThis as AzsGlobal).__AZS as (id: number) => void)(Number(call[1]));
    }
}

function mount(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

afterEach(() =>
{
    document.body.innerHTML = '';
    delete (globalThis as AzsGlobal).__AZS_S;
    delete (globalThis as AzsGlobal).__AZS;
});

describe('hydrating a streamed page', () =>
{
    it('adopts swapped content with no mismatch and no refetch; handlers work post-hydrate', async () =>
    {
        const fetcher = vi.fn(() => Promise.resolve('from-server'));
        const clicks = vi.fn();
        const app = (): HTMLElement =>
        {
            const a = createResource<string>(fetcher);
            return h('main', {},
                Suspense({
                    fallback: () => h('p', {}, 'loading'),
                    on: [a],
                    children: () => h('button', { onClick: clicks }, () => a.data() ?? '')
                }));
        };

        const chunks = await streamAll(renderToStream(app));
        expect(fetcher).toHaveBeenCalledTimes(1);

        const container = mount();
        container.innerHTML = chunks[0] as string;
        azsRuntime();
        for (const chunk of chunks.slice(1))
        {
            applyChunk(container, chunk);
        }
        expect(container.textContent).toContain('from-server');

        const warn = vi.spyOn(console, 'warn');
        hydrate(app, container);
        expect(warn.mock.calls.filter(call => String(call[0]).includes('hydrate'))).toEqual([]);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('from-server');

        container.querySelector('button')?.click();
        expect(clicks).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it('a resource created INSIDE the boundary children seeds through the boundary scope', async () =>
    {
        const outer = vi.fn(() => Promise.resolve('outer-data'));
        const inner = vi.fn(() => Promise.resolve('inner-data'));
        const app = (): HTMLElement =>
        {
            const a = createResource<string>(outer);
            return h('main', {},
                Suspense({
                    fallback: () => h('p', {}, 'wait'),
                    on: [a],
                    children: () =>
                    {
                        const b = createResource<string>(inner);
                        return h('div', {},
                            h('span', {}, () => a.data() ?? ''),
                            Suspense({
                                fallback: () => h('i', {}, 'inner-wait'),
                                on: [b],
                                children: () => h('em', {}, () => b.data() ?? '')
                            }));
                    }
                }));
        };

        const chunks = await streamAll(renderToStream(app));
        const container = mount();
        container.innerHTML = chunks[0] as string;
        azsRuntime();
        for (const chunk of chunks.slice(1))
        {
            applyChunk(container, chunk);
        }
        expect(container.textContent).toContain('outer-data');
        expect(container.textContent).toContain('inner-data');

        hydrate(app, container);
        expect(outer).toHaveBeenCalledTimes(1);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('inner-data');
    });

    it('an error seed hydrates the settled-with-error state without refetching', async () =>
    {
        const fetcher = vi.fn(() => Promise.reject(new Error('server fetch died')));
        const app = (): HTMLElement =>
        {
            const a = createResource<string>(fetcher);
            return h('main', {},
                Suspense({
                    fallback: () => h('p', {}, 'loading'),
                    on: [a],
                    children: () => h('div', {}, () => (a.error() !== null ? `failed: ${ (a.error() as Error).message }` : a.data() ?? ''))
                }));
        };

        const chunks = await streamAll(renderToStream(app));
        const container = mount();
        container.innerHTML = chunks[0] as string;
        azsRuntime();
        for (const chunk of chunks.slice(1))
        {
            applyChunk(container, chunk);
        }
        expect(container.textContent).toContain('failed: server fetch died');

        hydrate(app, container);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('failed: server fetch died');
    });

    it('a timed-out boundary hydrates its fallback and settles live client-side', async () =>
    {
        let release!: (value: string) => void;
        const gate = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        let calls = 0;
        const app = (): HTMLElement =>
        {
            const a = createResource<string>(() =>
            {
                calls++;
                return gate;
            });
            return h('main', {},
                Suspense({
                    fallback: () => h('p', {}, 'still-loading'),
                    on: [a],
                    children: () => h('div', {}, () => a.data() ?? '')
                }));
        };

        const chunks = await streamAll(renderToStream(app, { settleTimeoutMs: 20 }));
        expect(calls).toBe(1);
        const container = mount();
        container.innerHTML = chunks.join('');
        expect(container.textContent).toContain('still-loading');

        hydrate(app, container);
        expect(calls).toBe(2); // no seed: the client fetch is the degradation, by design
        expect(container.textContent).toContain('still-loading');

        release('late-data');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.textContent).toContain('late-data');
    });

    it('the balanced walk swaps correctly past a fallback containing its own control flow', async () =>
    {
        const fetcher = vi.fn(() => Promise.resolve('deep-value'));
        const app = (): HTMLElement =>
        {
            const [flag] = createSignal(true);
            const a = createResource<string>(fetcher);
            return h('main', {},
                Suspense({
                    fallback: () => Show({ when: flag, children: () => h('p', {}, 'nested-fallback') }),
                    on: [a],
                    children: () => h('div', {}, () => a.data() ?? '')
                }));
        };

        const chunks = await streamAll(renderToStream(app));
        const container = mount();
        container.innerHTML = chunks[0] as string;
        expect(container.textContent).toContain('nested-fallback');
        azsRuntime();
        for (const chunk of chunks.slice(1))
        {
            applyChunk(container, chunk);
        }
        expect(container.textContent).not.toContain('nested-fallback');
        expect(container.textContent).toContain('deep-value');
    });
});
