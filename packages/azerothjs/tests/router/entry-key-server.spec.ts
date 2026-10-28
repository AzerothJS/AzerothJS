// @vitest-environment node
//
// A server render boots its router on a fresh memory history: each request mints a key of its
// own, and nothing the server sends the client carries one.
import { expect, it } from 'vitest';
import { Routes, createMemoryHistory, createRouter, h, loaderHandoffScript, matchAndLoad, renderToStream, renderToString } from 'azerothjs';
import type { LoaderHandoff, MountNode, Route } from 'azerothjs';

const routes: Route[] = [{ path: '/p1', component: () => h('p', {}, 'page'), loader: async () => 'data' }];

function page(handoff: LoaderHandoff, keys: string[]): () => MountNode
{
    return () =>
    {
        const router = createRouter({ routes, history: createMemoryHistory('/p1'), initialLoaderData: handoff });
        keys.push(router.location().key);
        return h('div', {}, Routes({ router }));
    };
}

it('each request mints its own key, and neither the markup nor the loader handoff carries one', async () =>
{
    const keys: string[] = [];
    const sent: string[] = [];
    for (let request = 0; request < 3; request++)
    {
        const handoff = await matchAndLoad(routes, '/p1') as LoaderHandoff;
        sent.push(renderToString(page(handoff, keys)), loaderHandoffScript(handoff));
    }
    const handoff = await matchAndLoad(routes, '/p1') as LoaderHandoff;
    sent.push(await new Response(renderToStream(page(handoff, keys))).text());
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sent.filter((text) => text.includes('__az"') || keys.some((key) => text.includes(key)))).toEqual([]);
});
