// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { batch, cached, createResource, createRoot, createSignal, h, hydrate, render, renderToStream, revalidate, runInMode, Suspense } from 'azerothjs';
import type { Resource } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { clearStreamPage, streamPage } from '../ssr/stream-test-page.ts';

afterEach(() =>
{
    clearStreamPage();
    resetDataCache();
});

async function deferredPage(serverFails = false)
{
    let client = false;
    const requests: Array<{ signal: AbortSignal; result: PromiseWithResolvers<string> }> = [];
    const family = cached('stream-shared-flight', (signal: AbortSignal): Promise<string> =>
    {
        if (!client)
        {
            return serverFails ? Promise.reject(new Error('server failure')) : Promise.resolve('server value');
        }
        const result = Promise.withResolvers<string>();
        requests.push({ signal, result });
        return result.promise;
    });
    let item!: Resource<string>;
    const shell = () =>
    {
        item = createResource(family);
        return h('p', {}, 'shell');
    };
    const page = () => Suspense({ on: [item], fallback: () => h('small', {}, 'waiting'),
        children: () => h('b', {}, () => item.data() ?? (item.error() as Error | null)?.message) });
    const root = await streamPage(renderToStream(() => h('main', {},
        h('section', { id: 'shell' }, shell()), h('section', { id: 'page' }, page()))));
    const shellRoot = root.querySelector<HTMLElement>('#shell')!;
    const pageRoot = root.querySelector<HTMLElement>('#page')!;
    resetDataCache();
    client = true;
    hydrate(shell, shellRoot);
    expect(requests).toHaveLength(1);
    return { family, item, requests, pageRoot, adopt: () => hydrate(page, pageRoot), dispose: () =>
    {
        render(() => h('i', {}), pageRoot);
        render(() => h('i', {}), shellRoot);
    } };
}

it.each([false, true])('a late cached outcome replaces its own cold read (server failed=%s)', async failed =>
{
    const { requests, item, pageRoot, adopt, dispose } = await deferredPage(failed);
    try
    {
        const saved = pageRoot.querySelector('b');
        adopt();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.signal.aborted).toBe(true);
        expect(item.loading()).toBe(false);
        expect(pageRoot.querySelector('b')).toBe(saved);
        expect(pageRoot.textContent).toBe(failed ? 'server failure' : 'server value');
        requests[0]!.result.resolve('abandoned result');
        await Promise.resolve();
        expect(pageRoot.textContent).toBe(failed ? 'server failure' : 'server value');
    }
    finally
    {
        dispose();
    }
});

it('a late failure seed leaves another cache subscriber’s pending request alive', async () =>
{
    const { requests, family, item, adopt, dispose } = await deferredPage(true);
    const [other, stop] = createRoot(stop => [createResource(family), stop] as const);
    try
    {
        adopt();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.signal.aborted).toBe(false);
        expect((item.error() as Error).message).toBe('server failure');
        expect(other.error()).toBeNull();
        requests[0]!.result.resolve('shared result');
        await Promise.resolve();
        await Promise.resolve();
        expect(item.data()).toBe('shared result');
        expect(other.data()).toBe('shared result');
    }
    finally
    {
        stop();
        dispose();
    }
});

it('a late seed cannot settle the waiter for a cache invalidation', async () =>
{
    const { requests, family, item, adopt, dispose } = await deferredPage();
    try
    {
        let settled = false;
        const fresh = revalidate(family).then(() =>
        {
            settled = true;
        });
        adopt();
        expect(requests[0]!.signal.aborted).toBe(false);
        requests[0]!.result.resolve('before invalidation');
        await Promise.resolve();
        await Promise.resolve();
        expect(requests).toHaveLength(2);
        expect(settled).toBe(false);
        requests[1]!.result.resolve('after invalidation');
        await fresh;
        expect(item.data()).toBe('after invalidation');
    }
    finally
    {
        dispose();
    }
});

it('a queued first drive adopts the same logical source after an equal write', async () =>
{
    const [key, setKey] = createSignal({ id: 'A' });
    const requests: string[] = [];
    let client = false;
    const app = () =>
    {
        const item = createResource(key, source =>
        {
            requests.push(source.id);
            return Promise.resolve(source.id);
        }, { equals: (a, b) => a.id === b.id });
        if (client)
        {
            setKey({ id: 'A' });
        }
        return Suspense({ on: [item], children: () => h('b', {}, item.data), fallback: () => h('i', {}, 'waiting') });
    };
    const root = await streamPage(renderToStream(app));
    client = true;
    batch(() => hydrate(app, root));
    expect(root.textContent).toBe('A');
    expect(requests).toEqual(['A']);
});

it.each(['changed source', 'explicit refetch'])('refuses a superseded seed before its queued effect runs (%s)', async reason =>
{
    const [key, setKey] = createSignal('A');
    const pending = Promise.withResolvers<string>();
    let item!: Resource<string>;
    let client = false;
    const app = () =>
    {
        item = createResource(key, source => client ? pending.promise : Promise.resolve(source));
        if (client)
        {
            if (reason === 'changed source')
            {
                setKey('B');
            }
            else
            {
                void item.refetch();
            }
        }
        return Suspense({ on: [item], children: () => h('b', {}, item.data), fallback: () => h('i', {}, 'waiting') });
    };
    const root = await streamPage(renderToStream(app));
    client = true;
    batch(() =>
    {
        hydrate(app, root);
        expect(item.data()).toBeUndefined();
    });
    expect(root.textContent).toBe('waiting');
    pending.resolve('current value');
    await Promise.resolve();
    expect(root.textContent).toBe('current value');
});

it.each([false, true])('preserves a cache invalidation between adoption and the queued resource drive (joined=%s)', async join =>
{
    let client = false;
    const pending = Promise.withResolvers<string>();
    const requests: AbortSignal[] = [];
    const family = cached('invalidate-queued-seed', (signal: AbortSignal) =>
    {
        if (!client)
        {
            return Promise.resolve('server value');
        }
        requests.push(signal);
        return pending.promise;
    });
    let item!: Resource<string>;
    const app = () =>
    {
        item = createResource(family);
        return Suspense({ on: [item], children: () => h('b', {}, item.data), fallback: () => h('i', {}, 'waiting') });
    };
    const root = await streamPage(renderToStream(app));
    resetDataCache();
    client = true;
    let joined: Promise<string> | undefined;
    batch(() =>
    {
        hydrate(app, root);
        expect(item.data()).toBe('server value');
        void revalidate(family);
        if (join)
        {
            joined = family();
        }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.aborted).toBe(false);
    expect(item.refreshing()).toBe(true);
    pending.resolve('refreshed value');
    if (joined)
    {
        expect(await joined).toBe('refreshed value');
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent).toBe('refreshed value');
});

it.each(['pending', 'settled', 'refetched'])('a chunk delivered after shell hydration handles a %s first read', async state =>
{
    let client = false;
    let sourceReads = 0;
    const server = Promise.withResolvers<string>();
    const requests: Array<{ signal: AbortSignal; result: PromiseWithResolvers<string> }> = [];
    let item!: Resource<string>;
    const shell = () =>
    {
        item = createResource(() =>
        {
            sourceReads++;
            return 'A';
        }, (_key, signal) =>
        {
            if (!client)
            {
                return server.promise;
            }
            const result = Promise.withResolvers<string>();
            requests.push({ signal, result });
            return result.promise;
        });
        return h('p', {}, 'shell');
    };
    const page = () =>
    {
        const current = item;
        return Suspense({ on: [current], children: () => h('b', {}, current.data), fallback: () => h('i', {}, 'waiting') });
    };
    const reader = renderToStream(() => h('main', {},
        h('section', { id: 'shell' }, shell()), h('section', { id: 'page' }, page()))).getReader();
    const decoder = new TextDecoder();
    const root = await streamPage(decoder.decode((await reader.read()).value));
    const shellRoot = root.querySelector<HTMLElement>('#shell')!;
    const pageRoot = root.querySelector<HTMLElement>('#page')!;
    let retry: Promise<void> | undefined;
    try
    {
        client = true;
        sourceReads = 0;
        batch(() =>
        {
            hydrate(shell, shellRoot);
            expect(sourceReads).toBe(0);
        });
        expect(requests).toHaveLength(1);
        if (state === 'settled')
        {
            requests[0]!.result.resolve('current result');
            await Promise.resolve();
        }
        else if (state === 'refetched')
        {
            retry = item.refetch();
        }
        server.resolve('server result');
        await streamPage(decoder.decode((await reader.read()).value));
        const saved = pageRoot.querySelector('b')!;
        expect(saved.textContent).toBe('server result');
        hydrate(page, pageRoot);
        if (state === 'pending')
        {
            expect(requests[0]!.signal.aborted).toBe(true);
            expect(pageRoot.querySelector('b')).toBe(saved);
            requests[0]!.result.resolve('abandoned result');
            await Promise.resolve();
            expect(item.data()).toBe('server result');
        }
        else if (state === 'refetched')
        {
            expect(requests[1]!.signal.aborted).toBe(false);
            requests[1]!.result.resolve('current result');
            await retry;
        }
        expect(pageRoot.textContent).toBe(state === 'pending' ? 'server result' : 'current result');
    }
    finally
    {
        render(() => h('i', {}), pageRoot);
        render(() => h('i', {}), shellRoot);
        await reader.cancel();
    }
});

it('a failed hydration window relinquishes its seed receiver even if the owner outlives the window', async () =>
{
    let item!: Resource<string>;
    const page = () => Suspense({ on: [item], children: () => h('b', {}, item.data), fallback: () => h('i', {}, 'waiting') });
    const root = await streamPage(renderToStream(() =>
    {
        item = createResource(() => Promise.resolve('server'));
        return page();
    }));
    const stop = createRoot(dispose =>
    {
        expect(() => runInMode('hydrate', () =>
        {
            item = createResource(() => Promise.resolve('new request'));
            throw new Error('interrupted');
        })).toThrow('interrupted');
        return dispose;
    });
    try
    {
        hydrate(page, root);
        expect(item.data()).toBeUndefined();
        await item.refetch();
        expect(root.textContent).toBe('new request');
    }
    finally
    {
        stop();
    }
});
