// Full behavioral coverage for useLoader (use-loader.ts) and the router's loader
// resource (router.ts): loader runs on match, re-runs when params change, aborts
// the previous fetch on a mid-flight navigation, and stays idle for a null match
// or a loader-less route. Real promises (no mocked async) flushed with a real
// macrotask, all inside a createRoot driven by memory history.
import { describe, it, expect } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { createRouter, createMemoryHistory, useLoader } from '@azerothjs/router';
import type { Route, Router } from '@azerothjs/router';

const leaf = (): HTMLElement => document.createElement('div');

// Flush microtasks + a macrotask so loader promises settle.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Builds a router with the given routes on memory history inside a root, hands it
// to `fn`, and disposes afterward. `fn` may be async.
async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void> | void): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
    });
    try
    {
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

describe('useLoader - basic data flow', () =>
{
    it('returns the same shared resource object the router holds', async () =>
    {
        const routes: Route[] = [{ path: '/', component: leaf }];
        await withRouter(routes, '/', (router) =>
        {
            expect(useLoader(router)).toBe(router.loader);
        });
    });

    it('runs the matched loader and exposes its data', async () =>
    {
        const routes: Route[] =
        [
            { path: '/users/:id', component: leaf, loader: async ({ params }) => `user-${ params.id }` }
        ];
        await withRouter(routes, '/users/7', async (router) =>
        {
            const resource = useLoader<string>(router);
            expect(resource.loading()).toBe(true);
            expect(resource.data()).toBeUndefined();

            await flush();

            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBe('user-7');
            expect(resource.error()).toBeNull();
        });
    });

    it('passes the route params into the loader', async () =>
    {
        const received: string[] = [];
        const routes: Route[] =
        [
            {
                path: '/users/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    received.push(params.id ?? '');
                    return params.id;
                }
            }
        ];
        await withRouter(routes, '/users/42', async () =>
        {
            await flush();
            expect(received).toEqual(['42']);
        });
    });

    it('captures a rejected loader in error() and clears loading', async () =>
    {
        const routes: Route[] =
        [
            { path: '/', component: leaf, loader: async () =>
            {
                throw new Error('boom');
            } }
        ];
        await withRouter(routes, '/', async (router) =>
        {
            const resource = useLoader(router);
            await flush();
            expect(resource.loading()).toBe(false);
            expect((resource.error() as Error).message).toBe('boom');
            expect(resource.data()).toBeUndefined();
        });
    });
});

describe('useLoader - idle states', () =>
{
    it('stays idle when no route matches', async () =>
    {
        const routes: Route[] = [{ path: '/', component: leaf, loader: async () => 'x' }];
        await withRouter(routes, '/nope', async (router) =>
        {
            const resource = useLoader(router);
            await flush();
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();
        });
    });

    it('stays idle when the matched route has no loader', async () =>
    {
        const routes: Route[] = [{ path: '/', component: leaf }];
        await withRouter(routes, '/', async (router) =>
        {
            const resource = useLoader(router);
            await flush();
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();
        });
    });
});

describe('useLoader - re-running on navigation', () =>
{
    it('re-runs the loader when the param changes', async () =>
    {
        const calls: string[] = [];
        const routes: Route[] =
        [
            {
                path: '/users/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    calls.push(params.id ?? '');
                    return `user-${ params.id }`;
                }
            }
        ];
        await withRouter(routes, '/users/1', async (router) =>
        {
            const resource = useLoader<string>(router);
            await flush();
            expect(resource.data()).toBe('user-1');
            expect(calls).toEqual(['1']);

            router.navigate('/users/2');
            expect(resource.loading()).toBe(true);
            await flush();
            expect(resource.data()).toBe('user-2');
            expect(calls).toEqual(['1', '2']);
        });
    });

    it('does NOT re-run when only the hash changes (match is structurally equal)', async () =>
    {
        const calls: string[] = [];
        const routes: Route[] =
        [
            {
                path: '/users/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    calls.push(params.id ?? '');
                    return params.id;
                }
            }
        ];
        await withRouter(routes, '/users/1', async (router) =>
        {
            await flush();
            expect(calls).toEqual(['1']);

            router.navigate('/users/1#section');
            await flush();
            expect(calls).toEqual(['1']); // no extra run
        });
    });

    it('resets to idle when navigating from a loader route to a non-match', async () =>
    {
        const routes: Route[] =
        [
            { path: '/users/:id', component: leaf, loader: async ({ params }) => params.id }
        ];
        await withRouter(routes, '/users/1', async (router) =>
        {
            const resource = useLoader<string>(router);
            await flush();
            expect(resource.data()).toBe('1');

            router.navigate('/nope');
            await flush();
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();
        });
    });

    it('aborts the previous loader when navigation supersedes it mid-flight', async () =>
    {
        const aborted: string[] = [];
        const routes: Route[] =
        [
            {
                path: '/users/:id',
                component: leaf,
                loader: ({ params, signal }) =>
                    new Promise<string>((resolve, reject) =>
                    {
                        signal.addEventListener('abort', () =>
                        {
                            aborted.push(params.id ?? '');
                            reject(new Error('aborted'));
                        });
                        // Resolve after a macrotask so a quick navigation can abort it.
                        setTimeout(() => resolve(`user-${ params.id }`), 20);
                    })
            }
        ];
        await withRouter(routes, '/users/1', async (router) =>
        {
            const resource = useLoader<string>(router);
            // Supersede /users/1 before its 20ms timer fires.
            router.navigate('/users/2');
            // Let the abort + the second loader settle.
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(aborted).toContain('1');
            // The surviving fetch wins; the aborted one never overwrites it.
            expect(resource.data()).toBe('user-2');
        });
    });
});

describe('useLoader - refetch', () =>
{
    it('refetch() re-runs the active loader', async () =>
    {
        const calls: number[] = [];
        const routes: Route[] =
        [
            { path: '/', component: leaf, loader: async () =>
            {
                calls.push(1);
                return 'v';
            } }
        ];
        await withRouter(routes, '/', async (router) =>
        {
            const resource = useLoader<string>(router);
            await flush();
            expect(calls).toEqual([1]);

            resource.refetch();
            expect(resource.loading()).toBe(true);
            await flush();
            expect(calls).toEqual([1, 1]);
            expect(resource.data()).toBe('v');
        });
    });
});
