import { afterEach, expect, it, vi } from 'vitest';
import { cached, createEffect, createMemo, createMemoryHistory, createResource, createRoot, createRouter, createSelector, createSignal, untrack } from 'azerothjs';
import { latchServerData, resetDataCache } from 'azerothjs/internal';
import { until } from '../support/gated-cart.ts';

afterEach(() =>
{
    vi.restoreAllMocks();
    resetDataCache();
});

function warnings(): () => string[]
{
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return () => log.mock.calls.map(([message]) => String(message)).filter(message => message.includes('fetch source'));
}

it('warns once for a named fetcher even when it reads several times or refetches', async () =>
{
    const messages = warnings();
    const [snapshot] = createSignal('draft');
    const [id, setId] = createSignal(1);
    const [view, dispose] = createRoot(d => [createResource(id, async function readDraft()
    {
        return snapshot() + snapshot();
    }), d] as const);
    setId(2);
    await view.refetch();
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('readDraft');
    expect(messages()[0]).toContain('untrack');
    dispose();
});

it('ignores source-only, explicitly untracked, after-await and independent effect reads', async () =>
{
    const messages = warnings();
    const [source] = createSignal(7);
    const [value, setValue] = createSignal(1);
    let observed = 0;
    const dispose = createRoot(d =>
    {
        createResource(source, async () =>
        {
            untrack(value);
            createEffect(() =>
            {
                observed = value();
            });
            await Promise.resolve();
            return value();
        });
        return d;
    });
    setValue(2);
    await Promise.resolve();
    expect(observed).toBe(2);
    expect(messages()).toEqual([]);
    dispose();
});

it('attributes nested cached reads to their raw fetcher only and shares its allowance across aliases', async () =>
{
    const messages = warnings();
    const [value] = createSignal(5);
    const fetch = async (): Promise<number> => value();
    const inner = cached('inner-diagnostic', fetch);
    const alias = cached('alias-diagnostic', fetch);
    const outer = cached('outer-diagnostic', async () => inner());
    expect(await outer()).toBe(5);
    expect(await alias()).toBe(5);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('inner-diagnostic');
});

it('observes selector and memo reads without making them fetch dependencies', async () =>
{
    const messages = warnings();
    const [value, setValue] = createSignal(3);
    let starts = 0;
    const dispose = createRoot(d =>
    {
        const selected = createSelector(value);
        const doubled = createMemo(() => value() * 2);
        createResource(async function selectorRead()
        {
            starts++;
            return selected(3);
        });
        createResource(async function memoRead()
        {
            starts++;
            return doubled();
        });
        return d;
    });
    setValue(4);
    await Promise.resolve();
    expect(starts).toBe(2);
    expect(messages()).toHaveLength(2);
    expect(messages().join(' ')).toContain('selectorRead');
    expect(messages().join(' ')).toContain('memoRead');
    dispose();
});

it('restores the observer frame after a synchronous fetch failure on the cache-disabled path', async () =>
{
    const messages = warnings();
    const [value, setValue] = createSignal(1);
    const failure = new Error('fetch failed');
    const broken = cached('broken-diagnostic', (): Promise<number> =>
    {
        value();
        throw failure;
    });
    latchServerData();
    const observed: number[] = [];
    const dispose = createRoot(d =>
    {
        createEffect(() =>
        {
            expect(() => broken()).toThrow(failure);
            observed.push(value());
        });
        return d;
    });
    setValue(2);
    await Promise.resolve();
    expect(observed).toEqual([1, 2]);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('broken-diagnostic');
    dispose();
});

it('uses a fallback for a callable whose name getter throws', async () =>
{
    const messages = warnings();
    const [value] = createSignal(17);
    const fetcher = async (): Promise<number> => value();
    Object.defineProperty(fetcher, 'name', { get()
    {
        throw new Error('name unavailable');
    } });
    const [view, dispose] = createRoot(d => [createResource(fetcher), d] as const);
    try
    {
        await until(() => view.data() === 17, 'the fetch result');
        expect(messages()).toHaveLength(1);
        expect(messages()[0]).toContain('anonymous fetcher');
    }
    finally
    {
        dispose();
    }
});

it('preserves both fetch outcomes when an application logging sink throws', async () =>
{
    const loggingFailure = new Error('warning sink unavailable');
    const fetchFailure = new Error('fetch failed');
    const log = vi.spyOn(console, 'warn').mockImplementation(() =>
    {
        throw loggingFailure;
    });
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [value] = createSignal(7);
    const success = cached('warn-success', async () => value());
    const failure = cached('warn-failure', async () =>
    {
        value();
        throw fetchFailure;
    });
    await expect(success()).resolves.toBe(7);
    await expect(failure()).rejects.toBe(fetchFailure);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledWith(expect.any(String), loggingFailure);
});

it('attributes two distinct route loaders separately and keeps framework-only reads silent', async () =>
{
    const messages = warnings();
    const [value] = createSignal(1);
    const component = (): HTMLElement => document.createElement('main');
    const [router, dispose] = createRoot(d => [createRouter({
        history: createMemoryHistory('/'),
        routes: [
            { path: '/', component, loader: async () => 0 },
            { path: '/first', component, loader: async function firstLoader()
            {
                return value();
            } },
            { path: '/second', component, loader: async function secondLoader()
            {
                return value();
            } }
        ]
    }), d] as const);
    try
    {
        await until(() => router.loaders[0]?.data() === 0, 'initial loader');
        expect(messages()).toEqual([]);
        await router.prefetch('/first');
        await router.prefetch('/second');
        expect(messages()).toHaveLength(2);
        expect(messages()[0]).toContain('firstLoader');
        expect(messages()[1]).toContain('secondLoader');
    }
    finally
    {
        dispose();
    }
});
