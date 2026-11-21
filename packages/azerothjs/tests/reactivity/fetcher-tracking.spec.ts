// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import {
    cached, createContext, createEffect, createMutation, createResource, createRoot, createSignal,
    h, onCleanup, provideContext, render, revalidate, Suspense, useContext
} from 'azerothjs';
import { getDataCache, markServerRuntime, resetDataCache } from 'azerothjs/internal';
import { GatedServer, cartFamily, inc, mount, until } from '../support/gated-cart.ts';
import type { Cart } from '../support/gated-cart.ts';

afterEach(resetDataCache);

it('retains the same typed input under Suspense when only a fetcher read changes', async () =>
{
    const [filter, setFilter] = createSignal('old');
    const server = new GatedServer();
    const container = document.createElement('div');
    render(() =>
    {
        const result = createResource(signal =>
        {
            filter();
            return server.get(signal);
        });
        return h('main', {}, Suspense({
            on: [result],
            fallback: () => h('i', {}, 'loading'),
            children: () => h('input', {})
        }));
    }, container);
    try
    {
        expect(container.textContent).toBe('loading');
        await server.releaseGet(0);
        const input = container.querySelector('input')!;
        input.value = 'draft';
        setFilter('new');
        expect(container.querySelector('input')).toBe(input);
        expect(container.querySelector('input')?.value).toBe('draft');
        expect(server.gets).toHaveLength(1);
    }
    finally
    {
        render(() => h('i', {}), container);
    }
});

it('a source changes the request and refetch repeats it, while incidental reads leave it in flight', async () =>
{
    const [key, setKey] = createSignal(1);
    const [token, setToken] = createSignal('a');
    const server = new GatedServer(10);
    const starts: [number, string][] = [];
    const [resource, dispose] = createRoot(d => [createResource(key, (id, signal) =>
    {
        starts.push([id, token()]);
        return server.get(signal);
    }), d] as const);
    try
    {
        expect(starts).toEqual([[1, 'a']]);
        setToken('b');
        setToken('c');
        expect(server.aborted()).toBe(0);
        expect(starts).toHaveLength(1);
        setKey(2);
        expect(server.aborted()).toBe(1);
        await server.releaseGet(1);
        expect(resource.data()).toEqual({ count: 10 });
        const refreshed = resource.refetch();
        await server.releaseGet(2);
        await refreshed;
        expect(starts).toEqual([[1, 'a'], [2, 'c'], [2, 'c']]);
    }
    finally
    {
        dispose();
    }
});

it('a standalone load-more request can append its own result without scheduling another page', async () =>
{
    const [rows, setRows] = createSignal<number[]>([]);
    const server = new GatedServer(10);
    const [resource, dispose] = createRoot(d => [createResource(async signal =>
    {
        const previous = rows();
        const next = await server.get(signal);
        setRows([...previous, next.count]);
        return next.count;
    }), d] as const);
    try
    {
        await server.releaseGet(0);
        expect(rows()).toEqual([10]);
        expect(server.gets).toHaveLength(1);
        server.count = 20;
        const more = resource.refetch();
        await server.releaseGet(1);
        await more;
        expect([resource.data(), rows()]).toEqual([20, [10, 20]]);
        expect(server.gets).toHaveLength(2);
    }
    finally
    {
        dispose();
    }
});

it('keeps synchronous starts, owner context, abort registration and cleanup before a source supersedes a fetch', () =>
{
    const context = createContext('missing');
    const [key, setKey] = createSignal(1);
    const starts: (string | undefined)[] = [];
    const cleaned: number[] = [];
    const aborted: number[] = [];
    const dispose = createRoot(d =>
    {
        provideContext(context, 'provided');
        createResource(key, (id, signal) =>
        {
            starts.push(useContext(context));
            onCleanup(() => cleaned.push(id));
            signal.addEventListener('abort', () => aborted.push(id));
            return Promise.resolve(id);
        });
        return d;
    });
    try
    {
        expect(starts).toEqual(['provided']);
        setKey(2);
        expect(starts).toEqual(['provided', 'provided']);
        expect(aborted).toEqual([1]);
        expect(cleaned).toEqual([1]);
    }
    finally
    {
        dispose();
    }
    expect(aborted).toEqual([1, 2]);
    expect(cleaned).toEqual([1, 2]);
});

it.each(['enabled', 'disabled'] as const)('a direct cached call keeps its caller independent with caching %s', async mode =>
{
    if (mode === 'disabled')
    {
        markServerRuntime();
    }
    expect(getDataCache() === null).toBe(mode === 'disabled');
    const [token, setToken] = createSignal('old');
    const [request, setRequest] = createSignal(1);
    const calls: string[] = [];
    const seen: string[] = [];
    const read = cached('direct-tracking-' + mode, (key: number) =>
    {
        const value = String(key) + token();
        calls.push(value);
        return Promise.resolve(value);
    });
    const dispose = createRoot(d =>
    {
        createEffect(() =>
        {
            void read(request()).then(value => seen.push(value));
        });
        return d;
    });
    try
    {
        expect(calls).toEqual(['1old']);
        await until(() => seen.length === 1, 'first direct read');
        setToken('new');
        setRequest(2);
        await until(() => seen.includes('2new'), 'new explicit key');
        expect(calls).toEqual(['1old', '2new']);
        expect(seen).toEqual(calls);
    }
    finally
    {
        dispose();
    }
});

it.each(['refetch', 'revalidate'] as const)('a cached %s inside an effect follows only the caller’s explicit trigger', async method =>
{
    const [token, setToken] = createSignal('old');
    const [trigger, setTrigger] = createSignal(0);
    const server = new GatedServer();
    const tokens: string[] = [];
    const read = cached('tracking-' + method, (signal: AbortSignal) =>
    {
        tokens.push(token());
        return server.get(signal);
    });
    const view = mount(read);
    let runs = 0;
    let stop: (() => void) | undefined;
    try
    {
        await server.releaseGet(0);
        stop = createRoot(d =>
        {
            createEffect(() =>
            {
                if (trigger() === 0)
                {
                    return;
                }
                runs++;
                void (method === 'refetch' ? view.cart.refetch() : revalidate(read));
            });
            return d;
        });
        setTrigger(1);
        await server.releaseGet(1);
        setToken('new');
        expect(runs).toBe(1);
        setTrigger(2);
        await server.releaseGet(2);
        expect(tokens).toEqual(['old', 'old', 'new']);
        expect(runs).toBe(2);
    }
    finally
    {
        stop?.();
        view.dispose();
    }
});

it('an autosave tracks its explicit input and applies one optimistic increment per write', async () =>
{
    const server = new GatedServer(30);
    const cart = cartFamily(server, 'autosave-input');
    const view = mount(cart);
    const [text, setText] = createSignal('first');
    const [token, setToken] = createSignal('old');
    const writes: string[][] = [];
    const save = createMutation((input: string, signal: AbortSignal) =>
    {
        writes.push([input, token()]);
        return server.post(inc, signal);
    }, {
        optimistic: (_input, patch) => patch(cart, (before: Cart) => ({ count: before.count + 1 })),
        invalidates: []
    });
    let stop: (() => void) | undefined;
    try
    {
        await server.releaseGet(0);
        stop = createRoot(d =>
        {
            createEffect(() =>
            {
                void save.run(text());
            });
            return d;
        });
        expect(view.cart.data()?.count).toBe(31);
        setToken('new');
        expect(writes).toEqual([['first', 'old']]);
        expect(view.cart.data()?.count).toBe(31);
        (await server.postArrived(0)).release();
        await until(() => !save.pending(), 'first accepted write');
        setText('second');
        (await server.postArrived(1)).release();
        await until(() => !save.pending(), 'second accepted write');
        expect(writes).toEqual([['first', 'old'], ['second', 'new']]);
        expect(view.cart.data()?.count).toBe(32);
        expect(server.count).toBe(32);
    }
    finally
    {
        stop?.();
        save.cancel();
        view.dispose();
    }
});

it('keeps a reactive cancellation option in the synchronous run prefix outside the calling effect', async () =>
{
    const [currentSignal, setCurrentSignal] = createSignal(new AbortController().signal);
    const [input, setInput] = createSignal('first');
    const saved: string[] = [];
    const save = createMutation((text: string) =>
    {
        saved.push(text);
        return Promise.resolve(text);
    });
    const options = {
        get signal(): AbortSignal
        {
            return currentSignal();
        }
    };
    const stop = createRoot(d =>
    {
        createEffect(() =>
        {
            void save.run(input(), options);
        });
        return d;
    });
    try
    {
        setCurrentSignal(new AbortController().signal);
        expect(saved).toEqual(['first']);
        setInput('second');
        await until(() => !save.pending(), 'explicit saves');
        expect(saved).toEqual(['first', 'second']);
    }
    finally
    {
        stop();
    }
});

it('an already-aborted run revalidates its target without subscribing its caller', async () =>
{
    const [token, setToken] = createSignal('old');
    const server = new GatedServer();
    const tokens: string[] = [];
    const read = cached('abandoned-tracking', (signal: AbortSignal) =>
    {
        tokens.push(token());
        return server.get(signal);
    });
    const view = mount(read);
    const write = vi.fn(() => Promise.resolve(1));
    const mutation = createMutation(write, { invalidates: [read] });
    let calls = 0;
    let stop: (() => void) | undefined;
    try
    {
        await server.releaseGet(0);
        const reason = new Error('already cancelled');
        const signal = AbortSignal.abort(reason);
        const results: unknown[] = [];
        stop = createRoot(d =>
        {
            createEffect(() =>
            {
                calls++;
                void mutation.run(undefined, { signal }).then(result => results.push(result));
            });
            return d;
        });
        await server.releaseGet(1);
        setToken('new');
        expect(calls).toBe(1);
        expect(write).not.toHaveBeenCalled();
        expect(results).toEqual([{ ok: false, cancelled: true, error: reason }]);
        expect(tokens).toEqual(['old', 'old']);
    }
    finally
    {
        stop?.();
        view.dispose();
    }
});
