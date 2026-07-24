// The SSR loader handoff, exercised as the full fullstack loop it exists for:
//
//   HTTP request -> app.handle (the @azerothjs/http kernel) -> matchAndLoad runs the
//   route's loader server-side -> renderToDocument embeds the payload -> the "browser"
//   (happy-dom) reads it back -> a hydrating router ADOPTS it (loader NOT called again,
//   data synchronously present) -> a navigation runs the next loader for real.
//
// This is the property that makes the frontend and backend one framework: one route table,
// one loader, data crossing the boundary exactly once.

import { describe, it, expect, vi } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { App } from '@azerothjs/http';
import { html } from '@azerothjs/http';
import { renderToDocument } from '@azerothjs/server';
import {
    createRouter, createMemoryHistory,
    matchAndLoad, loaderHandoffScript, readLoaderHandoff, LOADER_HANDOFF_ID,
    type Route, type Router
} from '@azerothjs/router';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function buildRoutes(loader: (args: { params: Record<string, string> }) => Promise<unknown>): Route[]
{
    return [
        { path: '/', component: leaf },
        { path: '/users/:id', component: leaf, loader }
    ];
}

describe('server side: matchAndLoad + document embedding through the real HTTP kernel', () =>
{
    it('runs the matched loader and embeds the payload as an inert JSON tag', async () =>
    {
        const loader = vi.fn(async ({ params }: { params: Record<string, string> }) =>
            ({ id: params.id, name: `user-${ params.id }` }));
        const routes = buildRoutes(loader);

        const app = new App();
        app.get('/users/:id', async (context) =>
        {
            const handoff = await matchAndLoad(routes, context.url, { signal: context.request.signal });
            const doc = renderToDocument(() =>
            {
                // The page component would render the routed tree here; the handoff flow
                // under test is independent of what the body contains.
                const el = document.createElement('main');
                el.textContent = `ssr:${ JSON.stringify(handoff?.data) }`;
                return el;
            }, { head: loaderHandoffScript(handoff), title: 'ssr' });
            return html(doc);
        });

        const response = await app.handle(new Request('http://local/users/42'));
        const page = await response.text();

        expect(loader).toHaveBeenCalledTimes(1);
        expect(page).toContain(`id="${ LOADER_HANDOFF_ID }"`);
        expect(page).toContain('user-42');
        expect(page).toContain('ssr:{'); // the render itself saw the data
    });

    it('no loader on the matched route means no tag (and no branching for the caller)', async () =>
    {
        const routes = buildRoutes(async () => null);
        const handoff = await matchAndLoad(routes, new URL('http://local/'));
        expect(handoff).toBeNull();
        expect(loaderHandoffScript(handoff)).toBe('');
    });

    it('the embedding is inert against script-breakout payloads', async () =>
    {
        const routes: Route[] = [{
            path: '/evil', component: leaf,
            loader: async () => ({ bio: '</script><script>window.pwned = true</script>' })
        }];
        const handoff = await matchAndLoad(routes, new URL('http://local/evil'));
        const tag = loaderHandoffScript(handoff);
        expect(tag).not.toContain('</script><script>'); // the breakout cannot survive escaping
        expect(tag.match(/<script/g)).toHaveLength(1);  // exactly the one inert JSON tag
    });
});

describe('client side: adoption without a refetch', () =>
{
    function embed(handoffTag: string): void
    {
        document.head.insertAdjacentHTML('beforeend', handoffTag);
    }

    function cleanup(): void
    {
        document.getElementById(LOADER_HANDOFF_ID)?.remove();
    }

    it('readLoaderHandoff round-trips what the server embedded', async () =>
    {
        const routes = buildRoutes(async ({ params }) => ({ id: params.id }));
        const handoff = await matchAndLoad(routes, new URL('http://local/users/7?tab=posts'));
        embed(loaderHandoffScript(handoff));
        try
        {
            expect(readLoaderHandoff()).toEqual({ path: '/users/7?tab=posts', data: { id: '7' } });
        }
        finally
        {
            cleanup();
        }
    });

    it('the hydrating router ADOPTS the payload: data synchronously present, loader never called', async () =>
    {
        const clientLoader = vi.fn(async () => ({ fresh: true }));
        const routes = buildRoutes(clientLoader);
        embed(loaderHandoffScript({ path: '/users/42', data: { id: '42', name: 'user-42' } }));

        try
        {
            let dispose!: () => void;
            let router!: Router;
            createRoot((d) =>
            {
                dispose = d;
                router = createRouter({
                    routes,
                    history: createMemoryHistory('/users/42'),
                    initialLoaderData: readLoaderHandoff()
                });
                // Synchronous availability - what an SSR render (and hydration) reads.
                expect(router.loader.data()).toEqual({ id: '42', name: 'user-42' });
                expect(router.loader.loading()).toBe(false);
            });
            await flush();
            expect(clientLoader).not.toHaveBeenCalled(); // adopted, not refetched

            // A real navigation leaves the handoff behind and fetches normally.
            router.navigate('/users/43');
            await flush();
            expect(clientLoader).toHaveBeenCalledTimes(1);
            expect(router.loader.data()).toEqual({ fresh: true });
            dispose();
        }
        finally
        {
            cleanup();
        }
    });

    it('a path MISMATCH discards the payload and fetches (stale handoff cannot serve wrong data)', async () =>
    {
        const clientLoader = vi.fn(async ({ params }: { params: Record<string, string> }) => ({ id: params.id }));
        const routes = buildRoutes(clientLoader);

        let dispose!: () => void;
        let router!: Router;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({
                routes,
                history: createMemoryHistory('/users/9'),
                initialLoaderData: { path: '/users/OLD', data: { id: 'OLD' } }
            });
        });
        await flush();
        expect(clientLoader).toHaveBeenCalledTimes(1);
        expect(router.loader.data()).toEqual({ id: '9' });
        dispose();
    });

    it('no embedded tag means undefined - the plain client-side start', () =>
    {
        expect(readLoaderHandoff()).toBeUndefined();
    });
});
