// @vitest-environment happy-dom
//
// Hydrating a page whose LOADER failed on the server. The server renders that level's own
// failure UI and tells the client WHICH level failed; the client has to reach the same state on
// its first pass. Seeding the data instead - or leaving the level loading and refetching - makes
// the client render something the server did not, and a route tree mismatch is not cosmetic:
// the pass throws and the whole page falls back to a client render.
import { describe, it, expect, vi } from 'vitest';
import { createRouter, createMemoryHistory, h, hydrate, isNotFound, matchAndLoad, notFound, renderToString, Routes, Outlet, useLoader } from 'azerothjs';
import type { LoaderHandoff, MountNode, Route } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The handoff as the CLIENT receives it: through JSON. Handing the object over directly would
 * test a shape no browser ever sees - `undefined` survives a reference and becomes `null` on
 * the wire, which is exactly where a level-index confusion would hide.
 */
const overTheWire = (handoff: LoaderHandoff): LoaderHandoff =>
    JSON.parse(JSON.stringify(handoff)) as LoaderHandoff;

const Layout = (props: { children?: MountNode | undefined }): MountNode =>
    h('div', { id: 'layout' }, h('header', {}, 'shell'), Outlet({ children: props.children }));

const Leaf = (): MountNode =>
{
    const item = useLoader<string>();
    return h('section', { id: 'leaf' }, () =>
    {
        if (isNotFound(item.error()))
        {
            return h('p', { id: 'missing' }, 'NO SUCH ITEM');
        }
        return item.error() !== null
            ? h('p', { id: 'failed' }, 'COULD NOT LOAD')
            : h('p', { id: 'loaded' }, item.data() ?? '');
    });
};

/** Counts every call, so "the client refetched" is observable rather than assumed. */
const leafLoads = vi.fn();

const routes: Route[] = [{
    path: '/shop',
    component: Layout,
    loader: async () => 'LAYOUT',
    children: [{
        path: 'item/:id',
        component: Leaf,
        loader: async ({ params }) =>
        {
            leafLoads();
            if (params.id === 'broken')
            {
                throw new Error('database is down');
            }
            if (params.id === 'gone')
            {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- a not-found sentinel is a branded value, not an Error: throwing it IS the documented API
                throw notFound();
            }
            return `ITEM ${ params.id }`;
        }
    }]
}];

describe('hydrating a server-side loader failure', () =>
{
    it('adopts the failed level without a mismatch and without refetching it', async () =>
    {
        const url = '/shop/item/broken';
        const handoff = await matchAndLoad(routes, url) as LoaderHandoff;
        expect(handoff.failed).toEqual([1]);

        // The server's markup, produced exactly as createPageRenderer produces it.
        const serverRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: serverRouter })));
        document.body.appendChild(container);
        expect(container.querySelector('#failed')).not.toBeNull();
        expect(container.querySelector('#layout')).not.toBeNull();
        const serverLayout = container.querySelector('#layout');
        const serverFailed = container.querySelector('#failed');

        leafLoads.mockClear();
        const errors: unknown[] = [];
        const clientRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        try
        {
            hydrate(() => h('div', { id: 'app' }, Routes({ router: clientRouter })), container);
        }
        catch (error)
        {
            errors.push(error);
        }
        await flush();

        // A mismatch would have thrown; node identity proves the markup was ADOPTED, not rebuilt.
        expect(errors).toEqual([]);
        expect(container.querySelector('#layout')).toBe(serverLayout);
        expect(container.querySelector('#failed')).toBe(serverFailed);
        expect(container.querySelector('#loaded')).toBeNull();
        // The failure is the level's own, readable by its component.
        expect(clientRouter.loaders[1]?.error()).toBeInstanceOf(Error);
        // And the client did not quietly re-run the loader that just failed.
        expect(leafLoads).not.toHaveBeenCalled();
    });

    it('a declared not-found adopts as the SENTINEL, so isNotFound answers the same both sides', async () =>
    {
        const url = '/shop/item/gone';
        const handoff = await matchAndLoad(routes, url) as LoaderHandoff;
        expect(handoff.missing).toEqual([1]);

        const serverRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: serverRouter })));
        document.body.appendChild(container);
        expect(container.querySelector('#missing')).not.toBeNull();
        const serverMissing = container.querySelector('#missing');

        leafLoads.mockClear();
        const clientRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        hydrate(() => h('div', { id: 'app' }, Routes({ router: clientRouter })), container);
        await flush();

        expect(container.querySelector('#missing')).toBe(serverMissing);
        // The sentinel itself, rebuilt: a generic error would take the wrong branch.
        expect(isNotFound(clientRouter.loaders[1]?.error())).toBe(true);
        expect(container.querySelector('#failed')).toBeNull();
        expect(leafLoads).not.toHaveBeenCalled();
    });

    it('CONTROL: a healthy sibling adopts its DATA, and neither level reports a failure', async () =>
    {
        const url = '/shop/item/7';
        const handoff = await matchAndLoad(routes, url) as LoaderHandoff;
        expect(handoff.failed).toBeUndefined();

        const serverRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: serverRouter })));
        document.body.appendChild(container);
        expect(container.querySelector('#loaded')?.textContent).toBe('ITEM 7');

        leafLoads.mockClear();
        const clientRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: overTheWire(handoff) });
        hydrate(() => h('div', { id: 'app' }, Routes({ router: clientRouter })), container);
        await flush();

        expect(container.querySelector('#failed')).toBeNull();
        expect(clientRouter.loaders[1]?.error()).toBeNull();
        expect(leafLoads).not.toHaveBeenCalled();
    });
});
