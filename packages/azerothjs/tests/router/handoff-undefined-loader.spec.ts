// @vitest-environment happy-dom
//
// A loader that resolves undefined is handed off as null, the value the JSON wire carries, so a
// server-rendered page reads null on the server and the client. A failed level stays undefined.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, h, hydrate, matchAndLoad, Outlet, readLoaderHandoff, render, Routes, useLoader } from 'azerothjs';
import type { LoaderHandoff, MountNode, Route } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageApp } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

afterEach(() =>
{
    const root = document.getElementById('root');
    if (root !== null)
    {
        render(() => h('i', {}), root);
    }
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    resetDataCache();
});

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 6; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const tag = (value: unknown): string =>
    (value === undefined ? 'U' : value === null ? 'N' : typeof value === 'string' ? `V:${ value }` : 'V:object');

/** A root loader over a leaf whose loader resolves `leafValue`, or throws when it is an Error. */
function routesFor(leafValue: unknown, runs: { count: number }): Route[]
{
    const Leaf = (): MountNode =>
    {
        const loader = useLoader();
        return h('p', { id: 'leaf' }, () => tag(loader.data()));
    };
    const leaf: Route = {
        path: 'q',
        component: Leaf,
        loader: async (): Promise<unknown> =>
        {
            runs.count += 1;
            if (leafValue instanceof Error)
            {
                throw leafValue;
            }
            return leafValue;
        }
    };
    const Layout = (props: { children?: MountNode | undefined }): MountNode => h('div', {}, Outlet({ children: props.children }));
    return [{ path: '/', component: Layout, loader: async () => 'r', children: [leaf] }];
}

const appFor = (routes: Route[]): PageApp => (props) =>
{
    const router = createRouter
    ({
        routes,
        ...(props.url !== undefined ? { history: createMemoryHistory(props.url) } : {}),
        ...(props.handoff !== undefined ? { initialLoaderData: props.handoff } : {})
    });
    return h('div', {}, Routes({ router }));
};

/** Serves `/q`, then loads that document as a browser does and hydrates it from its handoff. */
async function roundTrip(leafValue: unknown, mode: 'buffered' | 'stream'): Promise<Record<string, unknown>>
{
    const runs = { count: 0 };
    const routes = routesFor(leafValue, runs);
    const app = appFor(routes);
    const result = await createPageRenderer(app, routes)('/q', SHELL, mode === 'stream' ? { stream: true } : undefined);
    const html = result.kind === 'stream' ? await new Response(result.stream).text() : result.kind === 'html' ? result.html : '';
    const server = /<p id="leaf">([^<]*)<\/p>/.exec(html.replace(/<!--[^]*?-->/g, ''))?.[1] ?? '<none>';
    const serverRuns = runs.count;

    const parsed = new DOMParser().parseFromString(html.replace(/<script>[^]*?<\/script>/g, ''), 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState({}, '', '/q');
    const before = document.getElementById('leaf');
    resetDataCache();
    runs.count = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handoff = readLoaderHandoff();
    hydrate(() => app(handoff !== undefined ? { handoff } : {}), document.getElementById('root') as HTMLElement);
    await flush();
    const leaf = document.getElementById('leaf');
    return { server, client: leaf?.textContent ?? '<none>', adopted: leaf === before, serverRuns, clientRuns: runs.count };
}

describe('a loader that resolves undefined', () =>
{
    it('is held as null in matchAndLoad data, the value the wire carries', async () =>
    {
        const loaded = await matchAndLoad(routesFor(undefined, { count: 0 }), '/q') as LoaderHandoff;
        expect({ data: loaded.data.map(tag), wire: JSON.stringify(loaded.data) }).toEqual({ data: ['V:r', 'N'], wire: '["r",null]' });
    });

    for (const mode of ['buffered', 'stream'] as const)
    {
        it(`reads null on the server and after hydration, ${ mode }`, async () =>
        {
            expect(await roundTrip(undefined, mode)).toEqual({ server: 'N', client: 'N', adopted: true, serverRuns: 1, clientRuns: 0 });
        });
    }

    it('CONTROL: a failed level stays undefined in matchAndLoad data', async () =>
    {
        const loaded = await matchAndLoad(routesFor(new Error('leaf failed'), { count: 0 }), '/q') as LoaderHandoff;
        expect({ data: loaded.data.map(tag), failed: loaded.failed }).toEqual({ data: ['V:r', 'U'], failed: [1] });
    });

    for (const [name, value, read] of [['a value', 'x', 'V:x'], ['null', null, 'N']] as const)
    {
        it(`CONTROL: a loader that resolves ${ name } reads the same on both sides`, async () =>
        {
            expect(await roundTrip(value, 'buffered')).toEqual({ server: read, client: read, adopted: true, serverRuns: 1, clientRuns: 0 });
        });
    }
});
