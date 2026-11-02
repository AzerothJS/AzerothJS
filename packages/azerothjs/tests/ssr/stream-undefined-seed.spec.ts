// @vitest-environment happy-dom
//
// A streamed render with an undefined seed runs the eager server fetch with seed ids aligned,
// and a stream page whose loader resolves undefined runs it once and shows the same on both sides.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense, cached, createMemoryHistory, createResource, createRouter, h, hydrate, readLoaderHandoff, render, renderToStream, Routes, useLoader } from 'azerothjs';
import type { MountNode, Resource, Route } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageApp } from '@azerothjs/kit/ssr';
import { azsRuntime } from '../../src/renderer/stream-swap.ts';

interface AzsGlobal
{
    __AZS_S?: Record<string, unknown>;
    __AZS?: (id: number) => void;
}

afterEach(() =>
{
    const root = document.getElementById('root');
    if (root !== null)
    {
        render(() => h('i', {}), root);
    }
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (globalThis as AzsGlobal).__AZS_S;
    delete (globalThis as AzsGlobal).__AZS;
    resetDataCache();
});

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 6; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

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

/** Runs each bare swap call in `html`, which a browser executes and innerHTML does not. */
function swap(html: string): void
{
    for (const call of html.matchAll(/__AZS\((\d+)\)/g))
    {
        (globalThis as AzsGlobal).__AZS?.(Number(call[1]));
    }
}

/** Applies one wire chunk the way a browser does: an inert insert, then its swap call. */
function applyChunk(container: HTMLElement, chunk: string): void
{
    const holder = document.createElement('div');
    holder.innerHTML = chunk.replace(/<script>[^]*?<\/script>/g, '');
    while (holder.firstChild !== null)
    {
        container.appendChild(holder.firstChild);
    }
    swap(chunk);
}

/** Streams `app` into a document, then hydrates it with the browser's live cache. */
async function streamThenHydrate(app: () => MountNode): Promise<{ swapped: string; settled: string }>
{
    const chunks = await streamAll(renderToStream(app));
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = chunks[0] ?? '';
    azsRuntime();
    for (const chunk of chunks.slice(1))
    {
        applyChunk(container, chunk);
    }
    const swapped = container.textContent;
    resetDataCache();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hydrate(app, container);
    await flush();
    return { swapped, settled: container.textContent };
}

const boundary = (on: Array<Resource<unknown>>, children: () => MountNode): MountNode =>
    Suspense({ fallback: () => h('p', {}, 'FALLBACK'), on, children });

describe('a streamed render with an undefined seed', () =>
{
    it('starts the eager server fetch for { initialValue: undefined } and streams its data', async () =>
    {
        const fetcher = vi.fn(() => Promise.resolve('server-data'));
        const html = (await streamAll(renderToStream(() =>
        {
            const resource = createResource<string>(fetcher, { initialValue: undefined });
            return h('main', {}, boundary([resource], () => h('p', {}, () => resource.data() ?? 'EMPTY')));
        }))).join('');
        expect({ calls: fetcher.mock.calls.length, streamed: html.includes('server-data') }).toEqual({ calls: 1, streamed: true });
    });

    it('keeps seed ids aligned: an undefined-seeded resource and a plain neighbour both reach their data', async () =>
    {
        const seeded = vi.fn(() => Promise.resolve('P'));
        const plain = vi.fn(() => Promise.resolve('N'));
        const app = (): MountNode =>
        {
            const p = createResource<string>(seeded, { initialValue: undefined });
            const n = createResource<string>(plain);
            return h('main', {}, boundary([p, n], () => h('p', {}, () => `${ p.data() ?? 'P-EMPTY' }|${ n.data() ?? 'N-EMPTY' }`)));
        };
        const seen = await streamThenHydrate(app);
        expect({ ...seen, seeded: seeded.mock.calls.length, plain: plain.mock.calls.length })
            .toEqual({ swapped: 'P|N', settled: 'P|N', seeded: 1, plain: 1 });
    });

    it('keeps seed ids aligned inside a boundary scope', async () =>
    {
        const outer = vi.fn(() => Promise.resolve('A'));
        const seeded = vi.fn(() => Promise.resolve('P'));
        const plain = vi.fn(() => Promise.resolve('N'));
        const app = (): MountNode =>
        {
            const a = createResource<string>(outer);
            return h('main', {}, boundary([a], () =>
            {
                const p = createResource<string>(seeded, { initialValue: undefined });
                const n = createResource<string>(plain);
                const inner = boundary([p, n], () => h('em', {}, () => `${ p.data() ?? 'P-EMPTY' }|${ n.data() ?? 'N-EMPTY' }`));
                return h('div', {}, h('span', {}, () => a.data() ?? 'A-EMPTY'), inner);
            }));
        };
        const seen = await streamThenHydrate(app);
        expect({ ...seen, outer: outer.mock.calls.length, seeded: seeded.mock.calls.length, plain: plain.mock.calls.length })
            .toEqual({ swapped: 'AP|N', settled: 'AP|N', outer: 1, seeded: 1, plain: 1 });
    });

    it('keeps seed ids aligned for cached fetchers', async () =>
    {
        const calls = { seeded: 0, plain: 0 };
        const seeded = cached('stream-undefined-seed.p', async (): Promise<string> =>
        {
            calls.seeded += 1;
            return 'P';
        });
        const plain = cached('stream-undefined-seed.n', async (): Promise<string> =>
        {
            calls.plain += 1;
            return 'N';
        });
        const app = (): MountNode =>
        {
            const p = createResource<string>(seeded, { initialValue: undefined });
            const n = createResource<string>(plain);
            return h('main', {}, boundary([p, n], () => h('p', {}, () => `${ p.data() ?? 'P-EMPTY' }|${ n.data() ?? 'N-EMPTY' }`)));
        };
        const seen = await streamThenHydrate(app);
        expect({ ...seen, ...calls }).toEqual({ swapped: 'P|N', settled: 'P|N', seeded: 1, plain: 1 });
    });

    it('CONTROL: a resource with no options starts the eager fetch and streams its data', async () =>
    {
        const fetcher = vi.fn(() => Promise.resolve('server-data'));
        const html = (await streamAll(renderToStream(() =>
        {
            const resource = createResource<string>(fetcher);
            return h('main', {}, boundary([resource], () => h('p', {}, () => resource.data() ?? 'EMPTY')));
        }))).join('');
        expect({ calls: fetcher.mock.calls.length, streamed: html.includes('server-data') }).toEqual({ calls: 1, streamed: true });
    });

    it('CONTROL: a real seed skips the eager fetch and renders inline', async () =>
    {
        const fetcher = vi.fn(() => Promise.resolve('server-data'));
        const html = (await streamAll(renderToStream(() =>
        {
            const resource = createResource<string>(fetcher, { initialValue: 'seeded' });
            return h('main', {}, boundary([resource], () => h('p', {}, () => resource.data() ?? 'EMPTY')));
        }))).join('');
        expect({ calls: fetcher.mock.calls.length, inline: html.includes('seeded') }).toEqual({ calls: 0, inline: true });
    });

    it('CONTROL: a server fetch that resolved undefined streams a seed the client adopts without fetching', async () =>
    {
        let phase: 'server' | 'client' = 'server';
        const runs = { server: 0, client: 0 };
        const app = (): MountNode =>
        {
            const u = createResource<string | undefined>(async () =>
            {
                runs[phase] += 1;
                return undefined;
            });
            const n = createResource<string>(async () => 'N');
            return h('main', {}, boundary([u, n], () => h('p', {}, () => `${ u.data() ?? 'U-EMPTY' }|${ n.data() ?? 'N-EMPTY' }`)));
        };
        const chunks = await streamAll(renderToStream(app));
        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = chunks[0] ?? '';
        azsRuntime();
        for (const chunk of chunks.slice(1))
        {
            applyChunk(container, chunk);
        }
        phase = 'client';
        resetDataCache();
        hydrate(app, container);
        await flush();
        expect({ runs, settled: container.textContent }).toEqual({ runs: { server: 1, client: 0 }, settled: 'U-EMPTY|N' });
    });
});

describe('a stream page whose loader resolves undefined', () =>
{
    const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

    /** Serves `/p` streamed, then loads that document as a browser does and hydrates it. */
    async function serveThenHydrate(loaderValue: unknown): Promise<Record<string, unknown>>
    {
        const log = { phase: 'server', loaderRuns: [] as string[], detailRuns: [] as string[] };
        const Page = (): MountNode =>
        {
            const loader = useLoader<string | null | undefined>();
            const detail = createResource<string | null>(async () =>
            {
                log.detailRuns.push(log.phase);
                return 'detail';
            }, { initialValue: loader.data() });
            return h('main', {}, boundary([detail], () => h('p', { id: 'out' }, () => detail.data() ?? 'EMPTY')));
        };
        const routes: Route[] = [{
            path: '/p',
            component: Page,
            loader: async (): Promise<unknown> =>
            {
                log.loaderRuns.push(log.phase);
                return loaderValue;
            }
        }];
        const app: PageApp = (props) =>
        {
            const router = createRouter
            ({
                routes,
                ...(props.url !== undefined ? { history: createMemoryHistory(props.url) } : {}),
                ...(props.handoff !== undefined ? { initialLoaderData: props.handoff } : {})
            });
            return h('div', {}, Routes({ router }));
        };
        const result = await createPageRenderer(app, routes)('/p', SHELL, { stream: true });
        const html = result.kind === 'stream' ? await new Response(result.stream).text() : '';

        log.phase = 'client';
        const parsed = new DOMParser().parseFromString(html.replace(/<script>[^]*?<\/script>/g, ''), 'text/html');
        document.head.innerHTML = parsed.head.innerHTML;
        document.body.innerHTML = parsed.body.innerHTML;
        history.replaceState({}, '', '/p');
        azsRuntime();
        swap(html);
        const swapped = document.getElementById('out')?.textContent ?? '<no #out>';
        resetDataCache();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handoff = readLoaderHandoff();
        hydrate(() => app(handoff !== undefined ? { handoff } : {}), document.getElementById('root') as HTMLElement);
        await flush();
        const settled = document.getElementById('out')?.textContent ?? '<no #out>';
        return { kind: result.kind, swapped, settled, loaderRuns: log.loaderRuns, detailRuns: log.detailRuns };
    }

    it('runs the loader once per request and shows the same thing on the server and the client', async () =>
    {
        expect(await serveThenHydrate(undefined))
            .toEqual({ kind: 'stream', swapped: 'EMPTY', settled: 'EMPTY', loaderRuns: ['server'], detailRuns: [] });
    });

    it('CONTROL: a loader that resolves a value runs once and seeds both sides alike', async () =>
    {
        expect(await serveThenHydrate('from-loader'))
            .toEqual({ kind: 'stream', swapped: 'from-loader', settled: 'from-loader', loaderRuns: ['server'], detailRuns: [] });
    });

    it('CONTROL: a loader that resolves null runs once and seeds both sides alike', async () =>
    {
        expect(await serveThenHydrate(null))
            .toEqual({ kind: 'stream', swapped: 'EMPTY', settled: 'EMPTY', loaderRuns: ['server'], detailRuns: [] });
    });
});
