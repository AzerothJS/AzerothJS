// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { object, string } from '@azerothjs/schema';
import {
    batch, createEffect, createMemoryHistory, createRouter, defineRoute, h, hydrate, matchAndLoad, Outlet, render, renderToString, Routes, untrack, useLoader
} from 'azerothjs';
import type { LoaderHandoff, Resource, Route, RouteComponent, Router } from 'azerothjs';
import { markServerRuntime, resetDataCache } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const cleanups: Array<() => void> = [];
afterEach(() =>
{
    for (const dispose of cleanups.splice(0).reverse())
    {
        dispose();
    }
    resetDataCache();
});

function open(view: () => HTMLElement): HTMLElement
{
    const host = document.createElement('div');
    render(view, host);
    cleanups.push(() => render(() => h('div', {}), host));
    return host;
}

function outcome(resource: Resource<unknown>): unknown[]
{
    return [resource.data(), resource.loading(), resource.refreshing(), resource.error()];
}

describe.each([true, false])('rendered loader ownership with cache=%s', cache =>
{
    it.each(['value', 'error'] as const)('preserves the first ever read of the old %s during a cold hold', async kind =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const chunk = Promise.withResolvers<RouteComponent>();
        const previousError = new Error('Caption unavailable');
        const calls: string[] = [];
        let local!: Resource<string>;
        let exact!: Resource<string>;
        let explicit!: Resource<string>;
        let router!: Router;
        const first = defineRoute('/paper', {
            loader: async () =>
            {
                calls.push('paper');
                if (kind === 'error')
                {
                    throw previousError;
                }
                return 'Paper caption';
            },
            component: () =>
            {
                local = useLoader<string>();
                exact = useLoader(first);
                explicit = useLoader<string>(router);
                return h('p', {}, 'Paper');
            }
        });
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: [
                first,
                { path: '/linen', lazy: () => chunk.promise, loader: async () =>
                {
                    calls.push('linen');
                    return 'Linen caption';
                } }
            ] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        expect(calls).toEqual(['paper']);
        router.navigate('/linen');
        await flush();
        expect(host.textContent).toBe('Paper');
        expect(router.loaders[0]!.data()).toBe('Linen caption');
        const expected = [kind === 'value' ? 'Paper caption' : undefined, false, false, kind === 'error' ? previousError : null];
        for (const captured of [local, exact, explicit])
        {
            expect(outcome(captured)).toEqual(expected);
        }
        await Promise.all([local.refetch(), exact.refetch(), explicit.refetch()]);
        expect(calls).toEqual(['paper', 'linen']);
        chunk.resolve(() => h('p', {}, 'Linen'));
        await flush();
        expect(host.textContent).toBe('Linen');
        await local.refetch();
        expect(calls).toEqual(['paper', 'linen']);
    });

    it('keeps current-level, explicit deepest, exact and foreign loader selection distinct in a retained layout', async () =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const chunk = Promise.withResolvers<RouteComponent>();
        const calls: string[] = [];
        const read = (label: string): (() => Promise<string>) => async () =>
        {
            calls.push(label);
            return label;
        };
        let local!: Resource<string>;
        let deepest!: Resource<string>;
        let exact!: Resource<string>;
        let separate!: Resource<string>;
        let router!: Router;
        let foreign!: Router;
        const first = defineRoute('paper', { loader: read('paper'), component: () => h('p', {}, 'Paper') });
        const host = open(() =>
        {
            foreign = createRouter({ history: createMemoryHistory('/elsewhere'), routes: [
                { path: '/elsewhere', loader: read('foreign'), component: () => h('p', {}, 'Elsewhere') }
            ] });
            router = createRouter({ history: createMemoryHistory('/gallery/paper'), routes: [
                { path: '/gallery', loader: read('gallery'), component: ({ children }) =>
                {
                    local = useLoader<string>();
                    deepest = useLoader<string>(router);
                    exact = useLoader(first, router);
                    separate = useLoader<string>(foreign);
                    return h('section', {}, Outlet({ children }));
                }, children: [first, { path: 'linen', lazy: () => chunk.promise, loader: read('linen') }] }
            ] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        const node = host.querySelector('section');
        expect([local.data(), deepest.data(), exact.data(), separate.data()]).toEqual(['gallery', 'paper', 'paper', 'foreign']);
        await local.refetch();
        expect(calls.filter(label => label === 'gallery')).toHaveLength(2);
        router.navigate('/gallery/linen');
        await flush();
        expect(host.querySelector('section')).toBe(node);
        expect([local.data(), deepest.data(), exact.data(), separate.data()]).toEqual(['gallery', 'paper', 'paper', 'foreign']);
        const linen = calls.filter(label => label === 'linen').length;
        await deepest.refetch();
        expect(calls.filter(label => label === 'linen')).toHaveLength(linen);
        chunk.resolve(() => h('p', {}, 'Linen'));
        await flush();
        expect(host.querySelector('section')).toBe(node);
        expect([local.data(), deepest.data(), exact.data(), separate.data()]).toEqual(['gallery', 'linen', undefined, 'foreign']);
        await deepest.refetch();
        expect(calls.filter(label => label === 'linen')).toHaveLength(linen + 1);
    });

    it('synchronous loader code can inspect its new query without seeing the previous caption in that scoped view', async () =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const blue = Promise.withResolvers<string>();
        const seen: Array<{ tone: string; local: unknown[]; raw: unknown[] }> = [];
        let local!: Resource<string>;
        let router!: Router;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper?tone=red'), routes: [
                { path: '/paper', search: object({ tone: string() }), component: () =>
                {
                    local = useLoader<string>();
                    return h('p', {}, 'Paper');
                }, loader: async ({ query }) =>
                {
                    if (query.tone === 'red')
                    {
                        return 'Red caption';
                    }
                    seen.push(untrack(() => ({ tone: String(query.tone), local: outcome(local), raw: outcome(router.loaders[0]!) })));
                    return blue.promise;
                } }
            ] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        expect(local.data()).toBe('Red caption');
        const samePage = host.querySelector('p');
        router.navigate('/paper?tone=blue');
        expect(seen).toHaveLength(1);
        expect(seen[0]!.tone).toBe('blue');
        expect(seen[0]!.local).toEqual([undefined, false, false, null]);
        expect(seen[0]!.raw[3]).toBeNull();
        expect(host.querySelector('p')).toBe(samePage);
        expect(local.loading()).toBe(true);
        blue.resolve('Blue caption');
        await flush();
        expect(outcome(local)).toEqual(['Blue caption', false, false, null]);
        expect(outcome(router.loaders[0]!)).toEqual(outcome(local));
    });

    it.each(['loading', 'refreshing'] as const)('freezes a %s snapshot and releases the old refetch waiter at handoff', async phase =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const old = Promise.withResolvers<string>();
        const incoming = Promise.withResolvers<string>();
        const chunk = Promise.withResolvers<RouteComponent>();
        let originalCalls = 0;
        let incomingCalls = 0;
        let router!: Router;
        let local!: Resource<string>;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: [
                { path: '/paper', component: () =>
                {
                    local = useLoader<string>();
                    return h('p', {}, 'Paper');
                }, loader: async () =>
                {
                    originalCalls++;
                    return phase === 'refreshing' && originalCalls === 1 ? 'Paper caption' : old.promise;
                } },
                { path: '/linen', lazy: () => chunk.promise, loader: () =>
                {
                    incomingCalls++;
                    return incoming.promise;
                } }
            ] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        const refresh = local.refetch();
        let released = false;
        let globalReleased = false;
        const rawRefresh = router.loaders[0]!.refetch();
        void rawRefresh.then(() =>
        {
            globalReleased = true;
        });
        void refresh.then(() =>
        {
            released = true;
        });
        await flush();
        const frozen = [phase === 'refreshing' ? 'Paper caption' : undefined, phase === 'loading', phase === 'refreshing', null];
        expect(outcome(local)).toEqual(frozen);
        expect(released).toBe(false);
        router.navigate('/linen');
        await flush();
        expect(host.textContent).toBe('Paper');
        expect(released).toBe(true);
        expect(globalReleased).toBe(false);
        expect(outcome(local)).toEqual(frozen);
        old.resolve('Late paper caption');
        incoming.resolve('Linen caption');
        await flush();
        expect(router.loaders[0]!.data()).toBe('Linen caption');
        expect(globalReleased).toBe(true);
        expect(outcome(local)).toEqual(frozen);
        const untilNow = incomingCalls;
        await local.refetch();
        expect(incomingCalls).toBe(untilNow);
        chunk.resolve(() => h('p', {}, 'Linen'));
        await flush();
        await refresh;
    });

    it('a retired loader capture cannot refetch even when its original key becomes current again', async () =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const papers: Array<Resource<string>> = [];
        const requests: string[] = [];
        let router!: Router;
        const page = (name: string): RouteComponent => () =>
        {
            if (name === 'paper')
            {
                papers.push(useLoader<string>());
            }
            return h('p', {}, name);
        };
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: ['paper', 'linen'].map(name => ({
                path: '/' + name, component: page(name), loader: async () =>
                {
                    requests.push(name);
                    return name;
                }
            })) });
            return h('main', {}, Routes({ router, transition: 'fade', transitionDuration: 1000 }));
        });
        await flush();
        router.navigate('/linen');
        router.navigate('/paper');
        await flush();
        expect(papers).toHaveLength(2);
        expect(host.querySelectorAll('p').length).toBeGreaterThan(0);
        const untilReturn = requests.length;
        await papers[0]!.refetch();
        expect(requests).toHaveLength(untilReturn);
        await papers[1]!.refetch();
        expect(requests.slice(untilReturn)).toEqual(['paper']);
    });
});

describe('scoped refetch scheduling', () =>
{
    it('a scoped data-only observer stays quiet when a prewarmed query key has the same caption', async () =>
    {
        const loads: string[] = [];
        const paint: Array<string | undefined> = [];
        let router!: Router;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper?tone=red'), routes: [{
                path: '/paper', search: object({ tone: string() }), loader: async ({ query }) =>
                {
                    loads.push(String(query.tone));
                    return 'Paper caption';
                }, component: () =>
                {
                    const caption = useLoader<string>();
                    createEffect(() =>
                    {
                        paint.push(caption.data());
                    });
                    return h('p', {}, 'Paper');
                }
            }] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        await router.prefetch('/paper?tone=blue');
        expect(loads).toEqual(['red', 'blue']);
        const before = [...paint];
        expect(before.at(-1)).toBe('Paper caption');
        const original = host.querySelector('p');
        router.navigate('/paper?tone=blue');
        await flush();
        expect(host.querySelector('p')).toBe(original);
        expect(router.location().query.tone).toBe('blue');
        expect(loads).toEqual(['red', 'blue']);
        expect(paint).toEqual(before);
    });

    it('does not forward an old scoped refetch batched with navigation to a prewarmed route', async () =>
    {
        const calls: string[] = [];
        let router!: Router;
        let scoped!: Resource<string>;
        const loader = (name: string): (() => Promise<string>) => async () =>
        {
            calls.push(name);
            return name;
        };
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: [
                { path: '/paper', loader: loader('paper'), component: () =>
                {
                    scoped = useLoader<string>();
                    return h('p', {}, 'Paper');
                } },
                { path: '/linen', loader: loader('linen'), component: () => h('p', {}, 'Linen') }
            ] });
            return h('main', {}, Routes({ router }));
        });
        await flush();
        await router.prefetch('/linen');
        expect(calls).toEqual(['paper', 'linen']);
        let pending!: Promise<void>;
        batch(() =>
        {
            pending = scoped.refetch();
            router.navigate('/linen');
        });
        await pending;
        expect(host.textContent).toBe('Linen');
        expect(router.loaders[0]!.data()).toBe('linen');
        expect(calls.filter(name => name === 'linen')).toHaveLength(1);
    });
});

describe('hydrated loader ownership', () =>
{
    it('adopts the served loader handoff once and preserves the unread caption during a later hold', async () =>
    {
        const routes: Route[] = [];
        const chunk = Promise.withResolvers<RouteComponent>();
        const calls: string[] = [];
        let local!: Resource<string>;
        const page: RouteComponent = () =>
        {
            local = useLoader<string>();
            return h('article', {}, 'Paper');
        };
        routes.push({ path: '/paper', component: page, loader: async () =>
        {
            calls.push('paper');
            return 'Paper caption';
        } }, { path: '/linen', lazy: () => chunk.promise, loader: async () =>
        {
            calls.push('linen');
            return 'Linen caption';
        } });
        const handoff = await matchAndLoad(routes, '/paper') as LoaderHandoff;
        const make = (): Router => createRouter({ history: createMemoryHistory('/paper'), routes, initialLoaderData: handoff });
        const app = (router: Router): HTMLElement => h('main', {}, Routes({ router }));
        const container = document.createElement('div');
        cleanups.push(() => render(() => h('div', {}), container));
        container.innerHTML = renderToString(() => app(make()));
        const served = container.querySelector('article');
        expect(served?.textContent).toBe('Paper');
        resetDataCache();
        const client = make();
        hydrate(() => app(client), container);
        expect(container.querySelector('article')).toBe(served);
        expect(calls).toEqual(['paper']);
        client.navigate('/linen');
        await flush();
        expect(container.querySelector('article')).toBe(served);
        expect(calls).toEqual(['paper', 'linen']);
        expect(local.data()).toBe('Paper caption');
        expect(client.loaders[0]!.data()).toBe('Linen caption');
        chunk.resolve(() => h('article', {}, 'Linen'));
        await flush();
        expect(container.textContent).toBe('Linen');
    });
});
