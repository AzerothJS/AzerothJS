// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { createEffect, createMemoryHistory, createRoot, createRouter, createSignal, h } from 'azerothjs';
import { getDataCache, markServerRuntime, resetDataCache } from 'azerothjs/internal';
import { until } from '../support/gated-cart.ts';

afterEach(resetDataCache);

const page = (): HTMLElement => h('main', {});

it.each(['enabled', 'disabled'] as const)('a loader keeps the matched parameter as its key with caching %s', async mode =>
{
    if (mode === 'disabled')
    {
        markServerRuntime();
    }
    expect(getDataCache() === null).toBe(mode === 'disabled');
    const [token, setToken] = createSignal('first');
    const loads: string[] = [];
    const [router, dispose] = createRoot(d => [createRouter({
        history: createMemoryHistory('/users/1'),
        routes: [{
            path: '/users/:id',
            component: page,
            loader: ({ params }) =>
            {
                const value = String(params.id) + token();
                loads.push(value);
                return Promise.resolve(value);
            }
        }]
    }), d] as const);
    try
    {
        await until(() => router.loaders[0]?.data() === '1first', 'first loader');
        setToken('next');
        router.navigate('/users/2');
        await until(() => router.loaders[0]?.data() === '2next', 'new route parameter');
        expect(loads).toEqual(['1first', '2next']);
    }
    finally
    {
        dispose();
    }
});

it.each(['prefetch', 'revalidate'] as const)('a router %s from an effect leaves its loader reads outside the effect', async method =>
{
    const [locale, setLocale] = createSignal('en');
    const [trigger, setTrigger] = createSignal(0);
    const loads: string[] = [];
    const [router, dispose] = createRoot(d => [createRouter({
        history: createMemoryHistory(method === 'prefetch' ? '/' : '/users/0'),
        routes: [
            { path: '/', component: page },
            {
                path: '/users/:id',
                component: page,
                loader: ({ params }) =>
                {
                    loads.push(String(params.id) + locale());
                    return Promise.resolve(loads.at(-1));
                }
            }
        ]
    }), d] as const);
    let stop: (() => void) | undefined;
    try
    {
        if (method === 'revalidate')
        {
            await until(() => router.loaders[0]?.data() === '0en', 'initial route loader');
            loads.length = 0;
        }
        let runs = 0;
        let completed = 0;
        stop = createRoot(d =>
        {
            createEffect(() =>
            {
                const key = trigger();
                if (key > 0)
                {
                    runs++;
                    const work = method === 'prefetch' ? router.prefetch('/users/' + String(key)) : router.revalidate();
                    void work.then(() =>
                    {
                        completed++;
                    });
                }
            });
            return d;
        });
        setTrigger(1);
        await until(() => completed === 1, 'the first router operation');
        setLocale('fr');
        expect(runs).toBe(1);
        setTrigger(2);
        await until(() => completed === 2, 'the second router operation');
        expect(loads).toEqual(method === 'prefetch' ? ['1en', '2fr'] : ['0en', '0fr']);
    }
    finally
    {
        stop?.();
        dispose();
    }
});

it('continues to reevaluate a synchronous guard and redirects when its signal changes', async () =>
{
    const [allowed, setAllowed] = createSignal(true);
    const [router, dispose] = createRoot(d => [createRouter({
        history: createMemoryHistory('/private'),
        routes: [
            { path: '/private', component: page, guard: () => allowed() || '/login' },
            { path: '/login', component: page }
        ]
    }), d] as const);
    try
    {
        expect(router.location().pathname).toBe('/private');
        setAllowed(false);
        await until(() => router.location().pathname === '/login', 'tracked guard redirect');
    }
    finally
    {
        dispose();
    }
});
