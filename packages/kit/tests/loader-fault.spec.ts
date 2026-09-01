// @vitest-environment node
//
// A LOADER that rejects, driven end to end through the REAL createPageRenderer and a REAL
// createRouter/Routes app. The client has always treated this as a per-LEVEL state: the failed
// level shows its own failure UI and the ancestor layout keeps rendering. The server threw the
// whole chain away and answered a bare JSON 500, so the same fault cost a scoped message in one
// mode and the entire page in the other. This pins the parity.
import { describe, expect, it, vi } from 'vitest';

import { Outlet, RouterProvider, Routes, createMemoryHistory, createRouter, h, useLoader } from 'azerothjs';
import type { LoaderHandoff, MountNode, Route } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const INTERNALS = 'connect ECONNREFUSED 10.0.0.7:5432 (user=svc_orders password=hunter2)';

const Layout = (props: { children?: MountNode | undefined }): MountNode =>
    h('section', { id: 'layout' }, h('h1', {}, 'SHOP'), Outlet({ children: props.children }));

const Leaf = (): MountNode =>
{
    const item = useLoader<string>();
    return h('div', { id: 'leaf' }, () =>
        (item.error() !== null
            ? h('p', { id: 'leaf-error' }, 'THIS ITEM COULD NOT BE LOADED')
            : h('p', { id: 'leaf-data' }, item.data() ?? '')));
};

const routes: Route[] = [{
    path: '/shop',
    component: Layout,
    loader: async () => 'LAYOUT DATA',
    children: [{
        path: 'item/:id',
        component: Leaf,
        loader: async ({ params }) =>
        {
            if (params.id === 'broken')
            {
                throw new Error(INTERNALS);
            }
            return `ITEM ${ params.id }`;
        }
    }]
}];

const App = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;

describe('a rejected loader through createPageRenderer', () =>
{
    const render = createPageRenderer(App, routes);

    it('serves the page at 500 with the failed level scoped, ancestors intact', async () =>
    {
        const onError = vi.fn();
        const result = await render('/shop/item/broken', SHELL, { onError });

        expect(result.kind).toBe('error');
        if (result.kind !== 'error')
        {
            return;
        }
        expect(result.status).toBe(500);
        // The ancestor loaded and rendered - an all-or-nothing chain lost it with the leaf.
        expect(result.html).toContain('id="layout"');
        expect(result.html).toContain('SHOP');
        // The failed level shows ITS OWN failure UI, which is what the client already does.
        expect(result.html).toContain('THIS ITEM COULD NOT BE LOADED');

        // The server hears the real fault, in full, exactly once.
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0]?.[0] as Error).message).toBe(INTERNALS);
    });

    it('never puts the failure on the wire', async () =>
    {
        const result = await render('/shop/item/broken', SHELL, { onError: () => undefined });
        // A 5xx message can hold a host, a user and a password - as this one deliberately does.
        expect(JSON.stringify(result)).not.toContain(INTERNALS);
        expect(JSON.stringify(result)).not.toContain('hunter2');
        // What DOES cross is which level failed, so the client lands in the same state.
        if (result.kind === 'error')
        {
            const payload = /id="__azeroth-loader-handoff">([^<]*)</.exec(result.html)?.[1];
            expect(JSON.parse(payload as string)).toMatchObject({ failed: [1] });
        }
    });

    it('a healthy sibling is untouched: 200, data rendered, nothing reported', async () =>
    {
        const onError = vi.fn();
        const result = await render('/shop/item/7', SHELL, { onError });
        expect(result.kind).toBe('html');
        if (result.kind === 'html')
        {
            expect(result.status).toBe(200);
            expect(result.html).toContain('ITEM 7');
        }
        expect(onError).not.toHaveBeenCalled();
    });
});
