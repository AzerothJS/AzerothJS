// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { batch, createMemoryHistory, createRoot, createRouter, h, LOADER_HANDOFF_VERSION } from 'azerothjs';
import { markServerRuntime, resetDataCache } from 'azerothjs/internal';
import type { Route, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

afterEach(resetDataCache);

describe.each([true, false])('guarded loader handoff with cache=%s', cache =>
{
    for (const seed of ['value', 'failed'] as const)
    {
        const timings = ['sync', 'delayed', 'different destination'] as const;
        it.each(timings)(`assigns the ${ seed } seed to its own first accepted loader (%s)`, async timing =>
        {
            if (!cache)
            {
                markServerRuntime();
            }
            const admission = Promise.withResolvers<boolean>();
            const requests: Array<{ series: string; page: string; respond: (value: string) => void }> = [];
            const loader: NonNullable<Route['loader']> = ({ params, query }) =>
            {
                const request = Promise.withResolvers<string>();
                requests.push({ series: String(params.series), page: String(query.page), respond: request.resolve });
                return request.promise;
            };
            const component = (): HTMLElement => h('p', {}, 'Ready');
            const start = '/book/one?page=1';
            let router!: Router;
            const dispose = createRoot(stop =>
            {
                batch(() =>
                {
                    router = createRouter({
                        routes: [
                            { path: '/book/:series', component, loader, guard: () => timing === 'delayed' ? admission.promise : true },
                            { path: '/shelf/:series', component, loader }
                        ],
                        history: createMemoryHistory(start),
                        initialLoaderData: {
                            version: LOADER_HANDOFF_VERSION, path: start, data: seed === 'value' ? ['ready'] : [null],
                            ...(seed === 'failed' ? { failed: [0] } : {})
                        }
                    });
                    if (timing === 'different destination')
                    {
                        router.navigate('/shelf/two?page=2');
                    }
                });
                return stop;
            });

            try
            {
                const level = router.loaders[0]!;
                if (timing === 'different destination')
                {
                    expect(requests).toHaveLength(1);
                    expect(requests[0]).toMatchObject({ series: 'two', page: '2' });
                    requests[0]!.respond('ready');
                    await flush();
                    expect(level.data()).toBe('ready');
                    expect(level.error()).toBeNull();
                    return;
                }

                if (timing === 'delayed')
                {
                    expect(router.match()).toBeNull();
                    expect(requests).toHaveLength(0);
                    expect(level.data()).toBeUndefined();
                    expect(level.error()).toBeNull();
                    admission.resolve(true);
                    await flush();
                }
                expect(router.match()?.pathname).toBe('/book/one');
                expect(requests).toHaveLength(0);
                expect(level.loading()).toBe(false);
                if (seed === 'value')
                {
                    expect(level.data()).toBe('ready');
                    expect(level.error()).toBeNull();
                }
                else
                {
                    expect(level.data()).toBeUndefined();
                    expect(level.error()).toBeInstanceOf(Error);
                }

                const refreshed = level.refetch();
                expect(requests).toHaveLength(1);
                expect(requests[0]).toMatchObject({ series: 'one', page: '1' });
                requests[0]!.respond('new edition');
                await refreshed;
                expect(level.data()).toBe('new edition');
                expect(level.error()).toBeNull();
            }
            finally
            {
                dispose();
            }
        });
    }
});

describe('first-drive loader seed semantics', () =>
{
    function boot(
        data: unknown,
        guard: NonNullable<Route['guard']>,
        loader: NonNullable<Route['loader']>,
        options: { failed?: number[]; at?: number } = {},
        duringConstruction?: (router: Router) => void)
    {
        let router!: Router;
        const dispose = createRoot(stop =>
        {
            batch(() =>
            {
                const component = (): HTMLElement => h('p', {}, 'Ready');
                router = createRouter({
                    routes: [{ path: '/book', component, guard, loader }, { path: '/shelf', component }],
                    history: createMemoryHistory('/book'),
                    initialLoaderData: { version: LOADER_HANDOFF_VERSION, path: '/book', data: [data], ...options }
                });
                duringConstruction?.(router);
            });
            return stop;
        });
        return { router, level: router.loaders[0]!, dispose };
    }

    it.each([null, false, 0, '', undefined])('distinguishes a delayed seed of %j from absent data', async value =>
    {
        const admission = Promise.withResolvers<boolean>();
        let calls = 0;
        const { level, dispose } = boot(value, () => admission.promise, async () =>
        {
            calls++;
            return 'loaded';
        });
        try
        {
            admission.resolve(true);
            await flush();
            expect(calls).toBe(value === undefined ? 1 : 0);
            expect(level.data()).toBe(value === undefined ? 'loaded' : value);
            expect(level.loading()).toBe(false);
        }
        finally
        {
            dispose();
        }
    });

    it.each([true, false])('an explicit construction-batch fetch overrides a usable seed with cache=%s', async cache =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const value = Promise.withResolvers<string>();
        let calls = 0;
        let refreshed!: Promise<void>;
        const { level, dispose } = boot('seed', () => true, () =>
        {
            calls++;
            return value.promise;
        }, {}, router =>
        {
            refreshed = router.loaders[0]!.refetch();
        });
        try
        {
            expect(calls).toBe(1);
            expect(level.data()).toBe('seed');
            expect(level.refreshing()).toBe(true);
            value.resolve('new edition');
            await refreshed;
            expect(level.data()).toBe('new edition');
            expect(calls).toBe(1);
        }
        finally
        {
            dispose();
        }
    });

    it('a stale handoff waits for admission, then displays the seed while healing once', async () =>
    {
        const admission = Promise.withResolvers<boolean>();
        const value = Promise.withResolvers<string>();
        let calls = 0;
        const { level, dispose } = boot('seed', () => admission.promise, () =>
        {
            calls++;
            return value.promise;
        }, { at: Date.now() - 60_000 });
        try
        {
            await flush();
            expect(calls).toBe(0);
            expect(level.data()).toBeUndefined();
            admission.resolve(true);
            await flush();
            expect(calls).toBe(1);
            expect(level.data()).toBe('seed');
            expect(level.loading()).toBe(false);
            expect(level.refreshing()).toBe(true);
            value.resolve('new edition');
            await flush();
            expect(level.data()).toBe('new edition');
            expect(calls).toBe(1);
        }
        finally
        {
            dispose();
        }
    });

    it.each(['value', 'error'] as const)('a completed same-key prefetch supplies its %s when a failed handoff is admitted', async outcome =>
    {
        const admission = Promise.withResolvers<boolean>();
        const prefetched = Promise.withResolvers<string>();
        const failure = new Error('Current catalog is unavailable');
        let calls = 0;
        const { router, level, dispose } = boot(null, () => admission.promise, () =>
        {
            calls++;
            return calls === 1 ? prefetched.promise : Promise.resolve('next edition');
        }, { failed: [0] });
        try
        {
            const warm = router.prefetch('/book');
            expect(calls).toBe(1);
            if (outcome === 'value')
            {
                prefetched.resolve('current edition');
            }
            else
            {
                prefetched.reject(failure);
            }
            await warm;
            expect(router.match()).toBeNull();
            expect(level.data()).toBeUndefined();
            expect(level.error()).toBeNull();
            admission.resolve(true);
            await flush();
            expect(calls).toBe(1);
            expect(level.data()).toBe(outcome === 'value' ? 'current edition' : undefined);
            expect(level.error()).toBe(outcome === 'value' ? null : failure);
            expect(level.loading()).toBe(false);

            await level.refetch();
            expect(calls).toBe(2);
            expect(level.data()).toBe('next edition');
            expect(level.error()).toBeNull();
        }
        finally
        {
            dispose();
        }
    });

    it.each([true, false])('a settled detour discards the initial failure before returning with cache=%s', async cache =>
    {
        if (!cache)
        {
            markServerRuntime();
        }
        const admission = Promise.withResolvers<boolean>();
        let calls = 0;
        const { router, level, dispose } = boot(null, () => admission.promise, async () =>
        {
            calls++;
            return 'loaded';
        }, { failed: [0] });
        try
        {
            router.navigate('/shelf');
            admission.resolve(true);
            await flush();
            expect(calls).toBe(0);
            router.navigate('/book');
            await flush();
            expect(calls).toBe(1);
            expect(level.data()).toBe('loaded');
            expect(level.error()).toBeNull();
        }
        finally
        {
            dispose();
        }
    });
});
