import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from '@azerothjs/core';
import { createRouter } from '../../packages/router/src/router.ts';
import { useLoader } from '../../packages/router/src/use-loader.ts';
import type { Route, RouteComponent } from '../../packages/router/src/types.ts';

// ── Helpers ──────────────────────────────────────────────────

async function flush(): Promise<void>
{
    for (let i = 0; i < 4; i++)
    {
        await Promise.resolve();
    }
}

// Stub component — these tests assert on the loader resource only,
// not on rendered output, so any shape will do.
const Stub: RouteComponent = () => document.createElement('div');

// ─────────────────────────────────────────────────────────────

describe('Route.loader + useLoader', () =>
{
    beforeEach(() =>
    {
        window.history.replaceState({}, '', '/initial');
    });

    it('runs the matched route\'s loader and populates useLoader().data()', async () =>
    {
        window.history.replaceState({}, '', '/users/42');

        await createRoot(async (dispose) =>
        {
            const routes: Route[] =
            [
                {
                    path: '/users/:id',
                    component: Stub,
                    loader: async () => ({ name: 'Ada' })
                }
            ];

            const router = createRouter({ routes });
            const resource = useLoader<{ name: string }>(router);

            expect(resource.loading()).toBe(true);
            expect(resource.data()).toBeUndefined();

            await flush();

            expect(resource.loading()).toBe(false);
            expect(resource.data()).toEqual({ name: 'Ada' });
            expect(resource.error()).toBeNull();

            dispose();
        });
    });

    it('passes { params, signal } to the loader', async () =>
    {
        window.history.replaceState({}, '', '/users/7');

        await createRoot(async (dispose) =>
        {
            const loader = vi.fn(async ({ params, signal }: { params: Record<string, string>; signal: AbortSignal }) =>
            {
                // Sanity-check the inputs at call time so a wrong
                // shape bubbles up immediately rather than as a
                // shape mismatch on data().
                expect(params).toEqual({ id: '7' });
                expect(signal).toBeInstanceOf(AbortSignal);
                expect(signal.aborted).toBe(false);
                return params.id;
            });

            const router = createRouter({
                routes: [{ path: '/users/:id', component: Stub, loader }]
            });

            const resource = useLoader<string>(router);
            await flush();

            expect(resource.data()).toBe('7');
            expect(loader).toHaveBeenCalledOnce();

            dispose();
        });
    });

    it('re-runs the loader when params change', async () =>
    {
        window.history.replaceState({}, '', '/users/1');

        await createRoot(async (dispose) =>
        {
            const loader = vi.fn(async ({ params }: { params: Record<string, string> }) =>
            {
                return `loaded-${ params.id }`;
            });

            const router = createRouter({
                routes: [{ path: '/users/:id', component: Stub, loader }]
            });
            const resource = useLoader<string>(router);

            await flush();
            expect(resource.data()).toBe('loaded-1');
            expect(loader).toHaveBeenCalledTimes(1);

            router.navigate('/users/2');
            await flush();
            expect(resource.data()).toBe('loaded-2');
            expect(loader).toHaveBeenCalledTimes(2);

            dispose();
        });
    });

    it('does NOT re-run the loader when only the hash changes', async () =>
    {
        window.history.replaceState({}, '', '/users/1');

        await createRoot(async (dispose) =>
        {
            const loader = vi.fn(async () => 'data');

            const router = createRouter({
                routes: [{ path: '/users/:id', component: Stub, loader }]
            });
            useLoader(router);

            await flush();
            expect(loader).toHaveBeenCalledTimes(1);

            // Only the hash changes — match memo's structural
            // equality should keep the loader inert.
            router.navigate('/users/1#bio');
            await flush();
            expect(loader).toHaveBeenCalledTimes(1);

            // Search-only change — same deal.
            router.navigate('/users/1?tab=posts');
            await flush();
            expect(loader).toHaveBeenCalledTimes(1);

            dispose();
        });
    });

    it('aborts the previous loader\'s signal when navigation supersedes it', async () =>
    {
        window.history.replaceState({}, '', '/users/1');

        await createRoot(async (dispose) =>
        {
            const signals: AbortSignal[] = [];
            const loader = vi.fn(({ signal }: { signal: AbortSignal }) =>
            {
                signals.push(signal);
                // Hold open — never resolves naturally.
                return new Promise<string>(() =>
                {});
            });

            const router = createRouter({
                routes: [{ path: '/users/:id', component: Stub, loader }]
            });
            useLoader(router);

            expect(signals[0].aborted).toBe(false);

            router.navigate('/users/2');
            expect(signals[0].aborted).toBe(true);
            expect(signals[1].aborted).toBe(false);

            router.navigate('/users/3');
            expect(signals[1].aborted).toBe(true);
            expect(signals[2].aborted).toBe(false);

            dispose();
        });
    });

    it('routes without a loader leave useLoader inert', async () =>
    {
        window.history.replaceState({}, '', '/about');

        await createRoot(async (dispose) =>
        {
            const router = createRouter({
                routes: [{ path: '/about', component: Stub }]
            });
            const resource = useLoader(router);

            // No loader on the matched route → resource is in the
            // "no key" state synchronously.
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();
            expect(resource.error()).toBeNull();

            await flush();

            // Still inert after the microtask queue drains.
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();

            dispose();
        });
    });

    it('unmatched URL leaves useLoader in the no-key state', async () =>
    {
        window.history.replaceState({}, '', '/no-such-route');

        await createRoot(async (dispose) =>
        {
            const loader = vi.fn(async () => 'never');

            const router = createRouter({
                routes: [{ path: '/somewhere', component: Stub, loader }]
            });
            const resource = useLoader(router);

            // No match → no fetch.
            expect(resource.loading()).toBe(false);
            expect(resource.data()).toBeUndefined();
            expect(loader).not.toHaveBeenCalled();

            await flush();
            expect(loader).not.toHaveBeenCalled();

            // And after navigating to a matching URL, the loader
            // wakes up — confirms the resource isn't permanently
            // disabled by the initial null match.
            router.navigate('/somewhere');
            await flush();
            expect(loader).toHaveBeenCalledOnce();
            expect(resource.data()).toBe('never');

            dispose();
        });
    });
});
