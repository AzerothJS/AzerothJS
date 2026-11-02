// @vitest-environment happy-dom
//
// A level with no loader reads undefined on a server-rendered page, on both sides, buffered and
// streamed, and when the host renders from a JSON copy of the handoff, where it crosses as null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, h, hydrate, loaderHandoffScript, matchAndLoad, Outlet, readLoaderHandoff, render, renderToString, Routes, Show, useLoader } from 'azerothjs';
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

type Mode = 'buffered' | 'stream';

/**
 * Renders `path` the way kit serves it, then loads that document as a browser does and hydrates
 * it from its handoff script. Reads each id's text on the server and after hydration.
 */
async function roundTrip(routes: Route[], path: string, mode: Mode, ids: string[]): Promise<Record<string, unknown>>
{
    const app = appFor(routes);
    const result = await createPageRenderer(app, routes)(path, SHELL, mode === 'stream' ? { stream: true } : undefined);
    const html = result.kind === 'stream' ? await new Response(result.stream).text() : result.kind === 'html' ? result.html : '';
    const status = result.kind === 'stream' || result.kind === 'html' ? result.status : result.kind;
    const clean = html.replace(/<!--[^]*?-->/g, '');
    const server = Object.fromEntries(ids.map((id) => [id, new RegExp(`<p id="${ id }">([^<]*)</p>`).exec(clean)?.[1] ?? '<none>']));

    const parsed = new DOMParser().parseFromString(html.replace(/<script>[^]*?<\/script>/g, ''), 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    history.replaceState({}, '', path);
    const before = ids.map((id) => document.getElementById(id));
    resetDataCache();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) =>
    {
        warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : typeof arg)).join(' '));
    });
    const handoff = readLoaderHandoff();
    hydrate(() => app(handoff !== undefined ? { handoff } : {}), document.getElementById('root') as HTMLElement);
    await flush();
    const client = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.textContent ?? '<none>']));
    const adopted = ids.every((id, index) => document.getElementById(id) === before[index]);
    return { status, server, client, adopted, warnings };
}

/** A layout with no loader of its own and none above it, over a leaf that loads `leafValue`. */
function tree(leafValue: unknown, depth: 2 | 3, guarded = false): Route[]
{
    const Reader = (props: { children?: MountNode | undefined }): MountNode =>
    {
        const loader = useLoader<{ text: string } | undefined>();
        const settled = (): MountNode => h('p', { id: 'lay' }, () => (loader.data() as { text: string }).text);
        const shown = guarded
            ? Show({ when: () => loader.data() !== undefined, fallback: () => h('p', { id: 'lay' }, 'IDLE'), children: settled })
            : h('p', { id: 'lay' }, () => tag(loader.data()));
        return h('div', {}, shown, Outlet({ children: props.children }));
    };
    const Plain = (props: { children?: MountNode | undefined }): MountNode => h('div', {}, Outlet({ children: props.children }));
    const Leaf = (): MountNode =>
    {
        const loader = useLoader();
        return h('p', { id: 'leaf' }, () => tag(loader.data()));
    };
    const leaf: Route = { path: 'q', component: Leaf, loader: async () => leafValue };
    return depth === 2
        ? [{ path: '/', component: Reader, children: [leaf] }]
        : [{ path: '/', component: Plain, children: [{ path: 's', component: Reader, children: [leaf] }] }];
}

describe('a level with no loader', () =>
{
    it('CONTROL: is undefined in matchAndLoad data beside a loading leaf', async () =>
    {
        const loaded = await matchAndLoad(tree('x', 2), '/q') as LoaderHandoff;
        expect(loaded.data.map(tag)).toEqual(['U', 'V:x']);
    });

    for (const mode of ['buffered', 'stream'] as const)
    {
        for (const depth of [2, 3] as const)
        {
            it(`CONTROL: reads undefined in a layout on the server and after hydration, ${ mode }, at depth ${ String(depth) }`, async () =>
            {
                const seen = await roundTrip(tree('x', depth), depth === 2 ? '/q' : '/s/q', mode, ['lay', 'leaf']);
                expect(seen).toEqual({ status: 200, server: { lay: 'U', leaf: 'V:x' }, client: { lay: 'U', leaf: 'V:x' }, adopted: true, warnings: [] });
            });
        }

        it(`CONTROL: lets a layout that guards on data() !== undefined render its idle branch, ${ mode }`, async () =>
        {
            const seen = await roundTrip(tree({ text: 'leaf' }, 2, true), '/q', mode, ['lay']);
            expect(seen).toEqual({ status: 200, server: { lay: 'IDLE' }, client: { lay: 'IDLE' }, adopted: true, warnings: [] });
        });
    }

    it('idles on the server when the host renders from a JSON copy of the handoff', async () =>
    {
        const routes = tree('x', 2);
        const app = appFor(routes);
        const loaded = await matchAndLoad(routes, '/q') as LoaderHandoff;
        const copy = JSON.parse(JSON.stringify(loaded)) as LoaderHandoff;
        const body = renderToString(() => app({ url: '/q', handoff: copy }));
        const server = /<p id="lay">([^<]*)<\/p>/.exec(body.replace(/<!--[^]*?-->/g, ''))?.[1];

        document.head.innerHTML = loaderHandoffScript(loaded);
        document.body.innerHTML = `<div id="root">${ body }</div>`;
        history.replaceState({}, '', '/q');
        const before = document.getElementById('lay');
        resetDataCache();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handoff = readLoaderHandoff();
        hydrate(() => app(handoff !== undefined ? { handoff } : {}), document.getElementById('root') as HTMLElement);
        await flush();
        const lay = document.getElementById('lay');
        expect({ copied: copy.data.map(tag), server, client: lay?.textContent, adopted: lay === before })
            .toEqual({ copied: ['N', 'V:x'], server: 'U', client: 'U', adopted: true });
    });

    it('CONTROL: the leaf that loads reads its value on both sides', async () =>
    {
        const seen = await roundTrip(tree('x', 2), '/q', 'buffered', ['leaf']);
        expect(seen).toEqual({ status: 200, server: { leaf: 'V:x' }, client: { leaf: 'V:x' }, adopted: true, warnings: [] });
    });
});
