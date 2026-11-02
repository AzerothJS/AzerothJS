// @vitest-environment happy-dom
//
// A resource seeded from a level the server could not load: `initialValue: loader.data()` alone
// fetches like an unseeded one; with `initialError: loader.error()` too, the level stays failed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createResource, createRouter, h, hydrate, notFound, readLoaderHandoff, render, Routes, useLoader } from 'azerothjs';
import type { MountNode, Resource, Route } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageApp } from '@azerothjs/kit/ssr';
import { azsRuntime } from '../../src/renderer/stream-swap.ts';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

afterEach(() =>
{
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    delete (globalThis as { __AZS_S?: unknown }).__AZS_S;
    delete (globalThis as { __AZS?: unknown }).__AZS;
    resetDataCache();
});

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 10; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

type Fault = 'resolve' | 'throw' | 'notFound';
type Bag = 'plain' | 'value' | 'mirror';

interface Load
{
    status: number | string;
    serverRuns: number;
    clientRuns: number;
}

/** A page whose resource is seeded per `bag` from a level whose loader settles per `fault`. */
function routesFor(fault: Fault, bag: Bag, runs: { phase: 'server' | 'client'; server: number; client: number }): Route[]
{
    const Page = (): MountNode =>
    {
        const loader = useLoader<string>();
        const fetcher = async (): Promise<string> =>
        {
            runs[runs.phase] += 1;
            return 'detail';
        };
        let detail: Resource<string>;
        if (bag === 'plain')
        {
            detail = createResource<string>(fetcher);
        }
        else if (bag === 'value')
        {
            detail = createResource<string>(fetcher, { initialValue: loader.data() });
        }
        else
        {
            detail = createResource<string>(fetcher, { initialValue: loader.data(), initialError: loader.error() });
        }
        return h('main', {}, h('p', { id: 'out' }, () => detail.data() ?? 'EMPTY'), () => (detail.loading() ? h('i', {}, 'LOADING') : null));
    };
    const loader = async (): Promise<string> =>
    {
        if (fault === 'throw')
        {
            throw new Error('database is down');
        }
        if (fault === 'notFound')
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a branded sentinel
            throw notFound();
        }
        return 'L';
    };
    return [{ path: '/', component: () => h('p', {}, 'home') }, { path: '/f', component: Page, loader }];
}

/** Serves `/f` the way kit does, loads that document as a browser does and hydrates it. */
async function directLoad(fault: Fault, bag: Bag, mode: 'buffered' | 'stream'): Promise<Load>
{
    const runs = { phase: 'server' as 'server' | 'client', server: 0, client: 0 };
    const routes = routesFor(fault, bag, runs);
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
    const result = await createPageRenderer(app, routes)('/f', SHELL, mode === 'stream' ? { stream: true } : undefined);
    const html = result.kind === 'stream' ? await new Response(result.stream).text() : result.kind === 'html' || result.kind === 'error' ? result.html : '';
    const status = result.kind === 'stream' || result.kind === 'html' || result.kind === 'error' ? result.status : result.kind;
    await flush();

    runs.phase = 'client';
    const parsed = new DOMParser().parseFromString(html.replace(/<script>[^]*?<\/script>/g, ''), 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState({}, '', '/f');
    azsRuntime();
    for (const call of html.matchAll(/__AZS\((\d+)\)/g))
    {
        (globalThis as { __AZS?: (id: number) => void }).__AZS?.(Number(call[1]));
    }
    resetDataCache();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handoff = readLoaderHandoff();
    const root = document.getElementById('root') as HTMLElement;
    hydrate(() => app(handoff !== undefined ? { handoff } : {}), root);
    await flush();
    warn.mockRestore();
    render(() => h('i', {}), root);
    return { status, serverRuns: runs.server, clientRuns: runs.client };
}

const SHAPES: Array<[string, Fault, 'buffered' | 'stream', number]> = [
    ['a buffered 500', 'throw', 'buffered', 500],
    ['a buffered 404', 'notFound', 'buffered', 404],
    ['a streamed 404', 'notFound', 'stream', 404]
];

describe('a resource seeded from a level the server could not load', () =>
{
    for (const [name, fault, mode, status] of SHAPES)
    {
        it(`fetches like an unseeded one with initialValue: loader.data() alone, on ${ name }`, async () =>
        {
            const plain = await directLoad(fault, 'plain', mode);
            const value = await directLoad(fault, 'value', mode);
            expect({ value, plainFetched: plain.serverRuns + plain.clientRuns > 0 }).toEqual({ value: plain, plainFetched: true });
            expect(plain.status).toBe(status);
        });

        it(`CONTROL: makes no request with initialError: loader.error() beside it, on ${ name }`, async () =>
        {
            expect(await directLoad(fault, 'mirror', mode)).toEqual({ status, serverRuns: 0, clientRuns: 0 });
        });
    }

    for (const mode of ['buffered', 'stream'] as const)
    {
        it(`CONTROL: makes no request when the loader resolved, ${ mode }, seeded either way`, async () =>
        {
            const value = await directLoad('resolve', 'value', mode);
            const mirror = await directLoad('resolve', 'mirror', mode);
            expect({ value, mirror }).toEqual({ value: { status: 200, serverRuns: 0, clientRuns: 0 }, mirror: { status: 200, serverRuns: 0, clientRuns: 0 } });
        });
    }
});
