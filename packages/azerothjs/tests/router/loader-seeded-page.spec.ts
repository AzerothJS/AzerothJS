// @vitest-environment happy-dom
//
// A page seeded with `{ initialValue: useLoader().data() }` is built before its loader settles on a
// client navigation, a param change and a client-rendered load, so it fetches its own data.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createResource, createRouter, h, render, Routes, useLoader, useParams, LOADER_HANDOFF_VERSION } from 'azerothjs';
import type { LoaderHandoff, Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
    document.body.innerHTML = '';
});

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 6; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

interface Log
{
    seeds: string[];
    fetches: string[];
}

function routesFor(log: Log, seedFromLoader: boolean): Route[]
{
    const Item = (): HTMLElement =>
    {
        const loader = useLoader<string>();
        const params = useParams();
        const seed = loader.data();
        log.seeds.push(seed ?? 'U');
        const fetcher = async (id: string): Promise<string> =>
        {
            log.fetches.push(id);
            return `fetched-${ id }`;
        };
        // The conditional form passes a bag only when the loader holds a value.
        const bag = seedFromLoader ? { initialValue: seed } : seed === undefined ? undefined : { initialValue: seed };
        const detail = createResource(() => params().id, fetcher, bag);
        return h('p', { id: 'detail' }, () => `${ detail.data() ?? 'EMPTY' }|${ detail.loading() ? 'loading' : 'idle' }`);
    };
    return [
        { path: '/', component: () => h('p', { id: 'home' }, 'home') },
        { path: '/items/:id', component: Item, loader: async ({ params }) => `loader-${ params.id ?? '' }` }
    ];
}

function mount(routes: Route[], url: string, handoff?: LoaderHandoff): { router: Router; text: () => string }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(url), ...(handoff !== undefined ? { initialLoaderData: handoff } : {}) });
        return h('div', {}, Routes({ router }));
    }, container);
    return { router, text: () => container.querySelector('#detail')?.textContent ?? '<no #detail>' };
}

const handoffFor = (id: string): LoaderHandoff => ({ version: LOADER_HANDOFF_VERSION, path: `/items/${ id }`, data: [`loader-${ id }`], at: Date.now() });

describe('a page seeded from its loader', () =>
{
    it('fetches its own data on a client navigation into it', async () =>
    {
        const log: Log = { seeds: [], fetches: [] };
        const { router, text } = mount(routesFor(log, true), '/');
        await flush();
        router.navigate('/items/1');
        await flush();
        expect({ ...log, text: text() }).toEqual({ seeds: ['U'], fetches: ['1'], text: 'fetched-1|idle' });
    });

    it('fetches the new id on a param change, where the incoming page is built with no seed', async () =>
    {
        const log: Log = { seeds: [], fetches: [] };
        const { router, text } = mount(routesFor(log, true), '/items/1', handoffFor('1'));
        await flush();
        const before = text();
        router.navigate('/items/2');
        await flush();
        expect({ before, seeds: log.seeds, fetchedTwo: log.fetches.includes('2'), text: text() })
            .toEqual({ before: 'loader-1|idle', seeds: ['loader-1', 'U'], fetchedTwo: true, text: 'fetched-2|idle' });
    });

    it('fetches its own data on a client-rendered direct load, which has no handoff', async () =>
    {
        const log: Log = { seeds: [], fetches: [] };
        const { text } = mount(routesFor(log, true), '/items/1');
        await flush();
        expect({ ...log, text: text() }).toEqual({ seeds: ['U'], fetches: ['1'], text: 'fetched-1|idle' });
    });

    it('CONTROL: a server-rendered direct load seeds the page from the handoff and fetches nothing', async () =>
    {
        const log: Log = { seeds: [], fetches: [] };
        const { text } = mount(routesFor(log, true), '/items/1', handoffFor('1'));
        await flush();
        expect({ ...log, text: text() }).toEqual({ seeds: ['loader-1'], fetches: [], text: 'loader-1|idle' });
    });

    it('CONTROL: a page that passes a bag only when it holds a seed fetches on a client navigation', async () =>
    {
        const log: Log = { seeds: [], fetches: [] };
        const { router, text } = mount(routesFor(log, false), '/');
        await flush();
        router.navigate('/items/1');
        await flush();
        expect({ ...log, text: text() }).toEqual({ seeds: ['U'], fetches: ['1'], text: 'fetched-1|idle' });
    });
});
