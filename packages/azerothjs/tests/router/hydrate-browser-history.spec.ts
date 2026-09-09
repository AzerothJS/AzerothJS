// @vitest-environment happy-dom
//
// Hydration the way a real page boots: browser history, the handoff read from its script tag,
// and the data cache live. Rendering the server markup in the same test latches the server and
// disables the cache, so the first two arms keep that as the control and the rest reset it.
import { describe, expect, it, vi } from 'vitest';
import {
    LOADER_HANDOFF_ID, Routes, createBrowserHistory, createMemoryHistory, createRouter, h, hydrate, isNotFound,
    loaderHandoffScript, matchAndLoad, notFound, readLoaderHandoff, renderToString, useLoader
} from 'azerothjs';
import type { LoaderHandoff, MountNode, Route } from 'azerothjs';
import { getDataCache, resetDataCache } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
            : h('p', { id: 'loaded' }, String(item.data()));
    });
};

/** Counts every call, so "the loader ran" is observable rather than assumed. */
const brokenLoads = vi.fn(async (): Promise<string> =>
{
    throw new Error('database is down');
});
const healthyLoads = vi.fn(async (): Promise<string> => 'ITEM');
/** Fails once, then heals: the shape that tells a live subscription from a dead one. */
const healingLoads = vi.fn(async (): Promise<string> =>
{
    if (healingLoads.mock.calls.length === 1)
    {
        throw new Error('first attempt is down');
    }
    return `healed-${ healingLoads.mock.calls.length }`;
});

const routes: Route[] = [
    {
        path: '/gone',
        component: Leaf,
        loader: async () =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a not-found sentinel is a branded value, not an Error: throwing it IS the documented API
            throw notFound();
        }
    },
    { path: '/broken', component: Leaf, loader: brokenLoads },
    { path: '/healthy', component: Leaf, loader: healthyLoads },
    { path: '/heals', component: Leaf, loader: healingLoads }
];

interface Booted
{
    router: ReturnType<typeof createRouter>;
    server: Element | null;
    cached: boolean;
}

async function boot(url: string, live = false): Promise<Booted>
{
    const handoff = await matchAndLoad(routes, url) as LoaderHandoff;
    const serverRouter = createRouter({ routes, history: createMemoryHistory(url), initialLoaderData: handoff });
    const html = renderToString(() => h('div', { id: 'app' }, Routes({ router: serverRouter })));
    document.body.innerHTML = `<div id="root">${ html }</div>${ loaderHandoffScript(handoff) }`;
    const happy = (window as unknown as { happyDOM?: { setURL: (url: string) => void } }).happyDOM;
    if (happy !== undefined)
    {
        happy.setURL(`http://local${ url }`);
    }
    else
    {
        window.history.replaceState(null, '', url);
    }
    expect(location.pathname).toBe(url);
    if (live)
    {
        // The server markup above LATCHED the server, which disables shared-scope caching for
        // the rest of this context. A real page boots with the cache live, so the arms that
        // care reset it here, after the server render and before the client boot.
        resetDataCache();
    }
    // Read BEFORE the client router is built: this is the state adoption happens in.
    const cached = getDataCache() !== null;
    const seed = readLoaderHandoff();
    expect(seed).toBeDefined();
    expect(document.getElementById(LOADER_HANDOFF_ID)).not.toBeNull();
    const server = document.querySelector('#leaf > p');
    const router = createRouter({ routes, history: createBrowserHistory(), initialLoaderData: seed });
    hydrate(() => h('div', { id: 'app' }, Routes({ router })), document.getElementById('root') as HTMLElement);
    await flush();
    return { router, server, cached };
}

describe('hydrating over the browser history adopts the server-side loader outcome (cache disabled by the latch)', () =>
{
    it('a declared not-found is the sentinel on the client, and the server node is kept', async () =>
    {
        const { router, server, cached } = await boot('/gone');
        expect(cached).toBe(false);
        expect(isNotFound(router.loaders[0]?.error())).toBe(true);
        expect(document.querySelector('#missing')).toBe(server);
        expect(document.querySelector('#loaded')).toBeNull();
    });

    it('a failed level is an error on the client, and the server node is kept', async () =>
    {
        const { router, server, cached } = await boot('/broken');
        expect(cached).toBe(false);
        expect(router.loaders[0]?.error()).toBeInstanceOf(Error);
        expect(document.querySelector('#failed')).toBe(server);
        expect(document.querySelector('#loaded')).toBeNull();
    });
});

// With the cache live the seed goes through the shared entry; a failure seed must not be
// published there or mirrored back over the page.
describe('hydrating with the data cache live, the way a browser boots', () =>
{
    it('keeps the seeded not-found instead of mirroring the shared entry over it', async () =>
    {
        const { router, server, cached } = await boot('/gone', true);
        expect(cached).toBe(true);
        expect(isNotFound(router.loaders[0]?.error())).toBe(true);
        expect(document.querySelector('#missing')).toBe(server);
        expect(document.querySelector('#loaded')).toBeNull();
    });

    it('keeps the seeded failure and never publishes it as a value: a prefetch of the same url fetches', async () =>
    {
        brokenLoads.mockClear();
        const { router, server, cached } = await boot('/broken', true);
        expect(cached).toBe(true);
        expect(router.loaders[0]?.error()).toBeInstanceOf(Error);
        expect(router.loaders[0]?.data()).toBeUndefined();
        expect(document.querySelector('#failed')).toBe(server);
        // Only the server's attempt so far: adoption ran no loader.
        expect(brokenLoads).toHaveBeenCalledTimes(1);
        // The entry holds no value, so the same key asked again is a real fetch. An entry written
        // `undefined` as a settled value would answer this without one.
        await router.prefetch('/broken');
        expect(brokenLoads).toHaveBeenCalledTimes(2);
    });

    it('a held failure stands until the entry settles, and the settle reaches this instance', async () =>
    {
        healingLoads.mockClear();
        const { router, cached } = await boot('/heals', true);
        expect(cached).toBe(true);
        expect(router.loaders[0]?.error()).toBeInstanceOf(Error);
        expect(healingLoads).toHaveBeenCalledTimes(1); // the server's attempt

        const settled = router.revalidate();
        // In flight: loading, and STILL the seeded failure - a fetch starting is not the
        // failure going away.
        expect(router.loaders[0]?.loading()).toBe(true);
        expect(router.loaders[0]?.error()).toBeInstanceOf(Error);
        await settled;
        await flush();
        // The subscription is live: the entry's settle superseded the seed.
        expect(router.loaders[0]?.data()).toBe('healed-2');
        expect(router.loaders[0]?.error()).toBeNull();
        expect(router.loaders[0]?.loading()).toBe(false);
    });

    it('CONTROL: a value seed is published to the entry, so a prefetch of the same url fetches nothing', async () =>
    {
        healthyLoads.mockClear();
        const { router, server, cached } = await boot('/healthy', true);
        expect(cached).toBe(true);
        expect(router.loaders[0]?.data()).toBe('ITEM');
        expect(document.querySelector('#loaded')).toBe(server);
        // The server's attempt is the only call: the entry holds the seed, so nothing refetches.
        expect(healthyLoads).toHaveBeenCalledTimes(1);
        await router.prefetch('/healthy');
        expect(healthyLoads).toHaveBeenCalledTimes(1);
    });
});
