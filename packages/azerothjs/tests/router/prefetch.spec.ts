// @vitest-environment happy-dom
//
// Prefetch fills the SAME cache entries a navigation reads. That is the whole design and the
// trap the charter names: a prefetch that warmed a cache of its own would double every fetch
// it was meant to save, and would look like it worked.
//
// So every arm here counts loader calls. A prefetch that quietly fetched twice would pass any
// assertion about the data being present.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRoot, createRouter, h, Link, render } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const leaf = (): HTMLElement => document.createElement('div');

interface Harness { router: Router; loads: string[]; chunks: number; dispose: () => void }

function harness(url = '/'): Harness
{
    const loads: string[] = [];
    let chunks = 0;
    const routes: Route[] = [
        { path: '/', component: leaf },
        {
            path: '/users/:id',
            component: leaf,
            loader: async ({ params }) =>
            {
                loads.push(params.id as string);
                await wait(15);
                return { id: params.id };
            }
        },
        {
            path: '/lazy',
            lazy: async () =>
            {
                chunks += 1;
                await wait(10);
                return { default: leaf };
            }
        }
    ];
    let router!: Router;
    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(url) });
    });
    return { router, loads, get chunks()
    {
        return chunks;
    }, dispose };
}

describe('router.prefetch', () =>
{
    it('warms a loader, and the navigation that follows costs NOTHING more', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        await app.router.prefetch('/users/7');
        expect(app.loads).toEqual(['7']);

        app.router.navigate('/users/7');
        await wait(60);
        // The one that matters: the navigation joined the warmed entry rather than refetching.
        expect(app.loads).toEqual(['7']);
        app.dispose();
    });

    it('a click landing MID-prefetch joins it instead of starting a second', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        const warming = app.router.prefetch('/users/7');
        await flush();
        // Navigating before the prefetch settles is the common case, and the case a separate
        // cache would silently double.
        app.router.navigate('/users/7');
        await warming;
        await wait(60);

        expect(app.loads).toEqual(['7']);
        app.dispose();
    });

    it('prefetching twice fetches once', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        await Promise.all([app.router.prefetch('/users/7'), app.router.prefetch('/users/7')]);
        await app.router.prefetch('/users/7');
        expect(app.loads).toEqual(['7']);
        app.dispose();
    });

    it('the hold serves ONCE: coming back later refetches like any other visit', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        await app.router.prefetch('/users/7');
        app.router.navigate('/users/7');
        await wait(60);
        expect(app.loads).toEqual(['7']);

        // Away and back. The entry still holds its value, but the prefetch's claim on it was
        // spent by the navigation it was made for - an unconsumed hold would make one prefetch
        // silently keep a page fresh for every later visit inside the retention window.
        app.router.navigate('/');
        await wait(40);
        app.router.navigate('/users/7');
        await wait(60);
        expect(app.loads).toEqual(['7', '7']);
        app.dispose();
    });

    it('keys on the URL: a different param is a different fetch', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        await app.router.prefetch('/users/7');
        await app.router.prefetch('/users/8');
        // The control for the dedupe arms above: they must not be passing because prefetch
        // silently does nothing.
        expect(app.loads).toEqual(['7', '8']);
        app.dispose();
    });

    it('downloads a lazy chunk ahead of the click', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();
        expect(app.chunks).toBe(0);

        await app.router.prefetch('/lazy');
        expect(app.chunks).toBe(1);

        app.router.navigate('/lazy');
        await wait(40);
        // Resolved chunks are cached per route, so the navigation re-imports nothing.
        expect(app.chunks).toBe(1);
        app.dispose();
    });

    it('does nothing for a URL that matches no route, or one off-origin', async () =>
    {
        resetDataCache();
        const app = harness();
        await flush();

        await app.router.prefetch('/nope');
        await app.router.prefetch('https://example.com/users/7');
        expect(app.loads).toEqual([]);
        app.dispose();
    });

    it('a failing loader is swallowed: nobody asked for this fetch', async () =>
    {
        resetDataCache();
        const attempts = vi.fn();
        const routes: Route[] = [
            { path: '/', component: leaf },
            {
                path: '/broken',
                component: leaf,
                loader: async () =>
                {
                    attempts();
                    await wait(5);
                    throw new Error('upstream is down');
                }
            }
        ];
        let router!: Router;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history: createMemoryHistory('/') });
        });
        await flush();

        // Must not reject: a prefetch surfacing as an unhandled rejection would turn a
        // performance hint into a crash on a page nobody navigated to.
        await expect(router.prefetch('/broken')).resolves.toBeUndefined();
        expect(attempts).toHaveBeenCalled();
        dispose();
    });

    it('the warmed VALUE is the one the level then serves, not a refetched lookalike', async () =>
    {
        resetDataCache();
        let served = 0;
        const routes: Route[] = [
            { path: '/', component: leaf },
            {
                path: '/users/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    served += 1;
                    await wait(15);
                    // The serial makes the two distinguishable: a refetch would answer #2.
                    return { id: params.id, serial: served };
                }
            }
        ];
        let router!: Router;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history: createMemoryHistory('/') });
        });
        await flush();

        await router.prefetch('/users/42');
        router.navigate('/users/42');
        await wait(60);

        expect(router.loaders[0]?.data()).toEqual({ id: '42', serial: 1 });
        expect(served).toBe(1);
        dispose();
    });
});

describe('<Link prefetch>', () =>
{
    /** Mounts a link into the document so real pointer and focus events reach it. */
    function linked(prefetch: 'hover' | 'viewport' | 'render' | undefined)
    {
        const loads: string[] = [];
        const routes: Route[] = [
            { path: '/', component: leaf },
            {
                path: '/users/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    loads.push(params.id as string);
                    await wait(10);
                    return { id: params.id };
                }
            }
        ];
        const container = document.createElement('div');
        document.body.appendChild(container);
        let router!: Router;
        createRoot(() =>
        {
            router = createRouter({ routes, history: createMemoryHistory('/') });
        });
        const asked = vi.fn();
        const realPrefetch = router.prefetch.bind(router);
        router.prefetch = (to): Promise<void> =>
        {
            asked();
            return realPrefetch(to);
        };
        render(() => Link({
            router,
            to: '/users/7',
            ...(prefetch !== undefined ? { prefetch } : {}),
            children: 'Open'
        }), container);
        const anchor = container.querySelector('a') as HTMLAnchorElement;
        return { loads, asked, anchor, dispose: (): void =>
        {
            render(() => h('div', {}), container); container.remove();
        } };
    }

    it('OFF by default: rendering a link spends nobody\'s bandwidth', async () =>
    {
        resetDataCache();
        const link = linked(undefined);
        await wait(40);
        link.anchor.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        link.anchor.dispatchEvent(new Event('focus', { bubbles: true }));
        await wait(40);
        // Asserted at the ASKING, not only at the loading: a default that warmed by some other
        // route would leave loads empty here only because this environment has no observer.
        expect(link.asked).not.toHaveBeenCalled();
        expect(link.loads).toEqual([]);
        link.dispose();
    });

    it("'hover' warms on pointer-enter, once however many times the pointer returns", async () =>
    {
        resetDataCache();
        const link = linked('hover');
        await wait(20);
        expect(link.loads).toEqual([]);

        link.anchor.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        link.anchor.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        link.anchor.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        await wait(40);
        // The link asks ONCE. Counting loads alone would not show this - the cache dedupes the
        // request either way - so the wasted work would be the key walk, invisible and real.
        expect(link.asked).toHaveBeenCalledTimes(1);
        expect(link.loads).toEqual(['7']);
        link.dispose();
    });

    it("'hover' also warms on FOCUS, so a keyboard user is not left out", async () =>
    {
        resetDataCache();
        const link = linked('hover');
        await wait(20);

        link.anchor.dispatchEvent(new Event('focus', { bubbles: true }));
        await wait(40);
        expect(link.loads).toEqual(['7']);
        link.dispose();
    });

    it("'render' warms immediately", async () =>
    {
        resetDataCache();
        const link = linked('render');
        await wait(40);
        expect(link.loads).toEqual(['7']);
        link.dispose();
    });
});
