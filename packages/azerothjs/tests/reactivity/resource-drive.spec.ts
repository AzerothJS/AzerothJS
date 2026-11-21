// @vitest-environment happy-dom
import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { batch, cached, catchError, createEffect, createResource, createRoot, createSignal } from 'azerothjs';
import type { Resource } from 'azerothjs';
import { markServerRuntime, resetDataCache } from 'azerothjs/internal';
import { GatedServer, track, turns } from '../support/gated-cart.ts';
import type { Cart, Tracked } from '../support/gated-cart.ts';

afterEach(resetDataCache);

it('resamples an ordinary source on explicit refetch', async () =>
{
    let current = 'one';
    const keys: string[] = [];
    const [resource, dispose] = createRoot(d => [createResource(() => current, key =>
    {
        keys.push(key);
        return Promise.resolve(key);
    }), d] as const);
    try
    {
        await turns(1);
        current = 'two';
        expect(resource.data()).toBe('one');
        await resource.refetch();
        expect(keys).toEqual(['one', 'two']);
        expect(resource.data()).toBe('two');
    }
    finally
    {
        dispose();
    }
});

it('routes a comparator exception through the construction scope and permits recovery', async () =>
{
    const [key, select] = createSignal(1);
    const server = new GatedServer();
    const refusal = new Error('cannot compare keys');
    let broken = false;
    const messages: unknown[] = [];
    const options = {
        name: 'fallible comparator',
        equals(left: number, right: number): boolean
        {
            if (broken)
            {
                throw refusal;
            }
            return left === right;
        }
    };
    let resource!: Resource<Cart>;
    const dispose = createRoot(d =>
    {
        catchError(() =>
        {
            resource = createResource(key, (_key, signal) => server.get(signal), options);
        }, reason => messages.push(reason));
        return d;
    });
    try
    {
        await server.releaseGet(0);
        const waiting = track(resource.refetch());
        await turns(1);
        broken = true;
        select(2);
        await turns(1);
        expect(messages).toEqual([refusal]);
        expect(waiting.done()).toBe(true);
        expect(server.gets).toHaveLength(2);
        broken = false;
        const retry = resource.refetch();
        await server.releaseGet(2);
        await retry;
        expect(resource.error()).toBeNull();
        expect(messages).toEqual([refusal]);
    }
    finally
    {
        dispose();
    }
});

it('releases an outstanding refetch when the new cached key already has a fresh answer', async () =>
{
    const server = new GatedServer(7);
    server.ignoreAbort = true;
    const read = cached('warm-destination', (_key: string, signal: AbortSignal) => server.get(signal), { fresh: Infinity });
    const warm = read('new');
    await server.releaseGet(0);
    await warm;
    const [key, select] = createSignal('old');
    server.count = 1;
    const [view, dispose] = createRoot(d => [createResource(key, read), d] as const);
    try
    {
        await server.releaseGet(1);
        const pending = track(view.refetch());
        await server.arrived(2);
        await turns(1);
        select('new');
        await turns(1);
        expect([pending.done(), view.data()?.count, view.loading(), view.refreshing()]).toEqual([true, 7, false, false]);
        expect(server.gets).toHaveLength(3);
        await server.releaseGet(2);
        expect(view.data()?.count).toBe(7);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached'] as const)('uses the %s source comparator for usable keys and always honors a skip transition', async kind =>
{
    interface Key { id: number; label: string }
    const [selection, select] = createSignal<Key | null>({ id: 1, label: 'before' });
    const [comparisonInput, changeComparisonInput] = createSignal(1);
    let comparisons = 0;
    const calls: number[] = [];
    const labels: string[] = [];
    const fetch = (key: Key): Promise<number> =>
    {
        calls.push(key.id);
        labels.push(key.label);
        return Promise.resolve(key.id);
    };
    const [view, dispose] = createRoot(d => [createResource(selection, kind === 'plain' ? fetch : cached('equal-objects', fetch), {
        name: 'by id',
        equals: (left, right) =>
        {
            expectTypeOf(left).toEqualTypeOf<Key>();
            expectTypeOf(right).toEqualTypeOf<Key>();
            comparisonInput();
            comparisons++;
            return left.id === right.id;
        }
    }), d] as const);
    try
    {
        await turns(1);
        select({ id: 1, label: 'renamed' });
        expect(calls).toEqual([1]);
        const compared = comparisons;
        expect(compared).toBeGreaterThan(0);
        changeComparisonInput(2);
        expect(comparisons).toBe(compared);
        await view.refetch();
        expect(calls).toEqual([1, 1]);
        expect(labels).toEqual(['before', 'before']);
        select(null);
        expect(view.data()).toBeUndefined();
        select({ id: 2, label: 'other' });
        await turns(1);
        expect(calls).toEqual([1, 1, 2]);
        expect(view.data()).toBe(2);
    }
    finally
    {
        dispose();
    }
});

it('releases waiters on a source exception and retries the source through its captured error scope', async () =>
{
    const [revision, change] = createSignal(1);
    const server = new GatedServer(5);
    server.ignoreAbort = true;
    const sentinel = new Error('source failed');
    const seen: unknown[] = [];
    let fails = false;
    let resource!: Resource<Cart>;
    const dispose = createRoot(d =>
    {
        catchError(() =>
        {
            resource = createResource(() =>
            {
                const id = revision();
                if (fails)
                {
                    throw sentinel;
                }
                return id;
            }, (_id, signal) => server.get(signal));
        }, error => seen.push(error));
        return d;
    });
    try
    {
        await server.releaseGet(0);
        const forced = track(resource.refetch());
        await turns(1);
        fails = true;
        change(2);
        await turns(1);
        expect(seen).toEqual([sentinel]);
        expect(forced.done()).toBe(true);
        expect(forced.failure()).toBeUndefined();
        expect(server.gets[1]!.aborted).toBe(true);
        fails = false;
        server.count = 9;
        const retry = track(resource.refetch());
        await server.releaseGet(2);
        expect([retry.done(), resource.data()?.count]).toEqual([true, 9]);
        expect(seen).toEqual([sentinel]);
    }
    finally
    {
        dispose();
    }
});

it('keeps another subscriber’s old cache request alive while this instance’s waiter follows its new key', async () =>
{
    const server = new GatedServer(1);
    const [key, setKey] = createSignal('old');
    const fetch = cached('two-observers-moving', (_id: string, signal: AbortSignal) => server.get(signal));
    const [moving, staying, dispose] = createRoot(d => [createResource(key, fetch), createResource(() => 'old', fetch), d] as const);
    try
    {
        await server.releaseGet(0);
        server.count = 2;
        const forced = track(moving.refetch());
        const old = await server.arrived(1);
        server.count = 3;
        setKey('new');
        await server.arrived(2);
        expect(old.aborted).toBe(false);
        await server.releaseGet(1);
        expect(staying.data()?.count).toBe(2);
        expect(moving.data()).toBeUndefined();
        expect(forced.done()).toBe(false);
        await server.releaseGet(2);
        expect([forced.done(), moving.data()?.count]).toEqual([true, 3]);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached'] as const)('a batched %s refetch before the first unseeded run joins the initial request', async kind =>
{
    const server = new GatedServer(7);
    const read = (signal: AbortSignal): Promise<Cart> => server.get(signal);
    let pending!: Tracked<void>;
    let resource!: Resource<Cart>;
    const dispose = createRoot(d =>
    {
        batch(() =>
        {
            resource = createResource(kind === 'plain' ? read : cached('batch-empty', read));
            pending = track(resource.refetch());
            expect(server.gets).toHaveLength(0);
        });
        return d;
    });
    try
    {
        await turns(1);
        expect(server.gets).toHaveLength(1);
        expect([pending.done(), resource.loading()]).toEqual([false, true]);
        await server.releaseGet(0);
        expect([pending.done(), resource.data()?.count]).toEqual([true, 7]);
    }
    finally
    {
        dispose();
    }
});

it('keeps an equal key’s in-flight request and retries a failed key only on an explicit refetch', async () =>
{
    const [name, rename] = createSignal('one');
    const [id, setId] = createSignal(1);
    const server = new GatedServer(5);
    const keys: number[] = [];
    const [resource, dispose] = createRoot(d => [createResource(() =>
    {
        name();
        return id();
    }, (key, signal) =>
    {
        keys.push(key);
        return server.get(signal);
    }), d] as const);
    try
    {
        const first = await server.arrived(0);
        rename('two');
        rename('three');
        expect(keys).toEqual([1]);
        expect(first.aborted).toBe(false);
        first.fail();
        await turns(1);
        const failure = resource.error();
        expect(failure).toBeInstanceOf(Error);
        rename('four');
        expect(resource.error()).toBe(failure);
        expect(keys).toEqual([1]);
        const retry = resource.refetch();
        await server.releaseGet(1);
        await retry;
        setId(2);
        expect(resource.data()).toBeUndefined();
        expect(resource.loading()).toBe(true);
        await server.releaseGet(2);
        expect(keys).toEqual([1, 1, 2]);
        expect(resource.data()?.count).toBe(5);
    }
    finally
    {
        dispose();
    }
});

it('compares keys with Object.is, keeps zero and empty-string keys, and suspends only for a skip value', async () =>
{
    type Key = number | string | false | null | undefined;
    const [input, setInput] = createSignal<{ key: Key }>({ key: NaN });
    const keys: Key[] = [];
    const [resource, dispose] = createRoot(d => [createResource(() => input().key, value =>
    {
        keys.push(value);
        return Promise.resolve('loaded');
    }), d] as const);
    try
    {
        setInput({ key: NaN });
        setInput({ key: 0 });
        setInput({ key: -0 });
        setInput({ key: '' });
        await turns(1);
        expect(keys).toEqual([NaN, 0, -0, '']);
        for (const key of [false, null, undefined] as const)
        {
            setInput({ key });
            await resource.refetch();
            expect(resource.data()).toBeUndefined();
            expect(resource.loading()).toBe(false);
        }
        setInput({ key: '' });
        await turns(1);
        expect(keys).toEqual([NaN, 0, -0, '', '']);
    }
    finally
    {
        dispose();
    }
});

it('evaluates its first source at batch flush and releases its owner on disposal', () =>
{
    const [key, setKey] = createSignal(1);
    const reads: number[] = [];
    const requests: number[] = [];
    const dispose = createRoot(d =>
    {
        batch(() =>
        {
            createResource(() =>
            {
                const value = key();
                reads.push(value);
                return value;
            }, value =>
            {
                requests.push(value);
                return Promise.resolve(value);
            });
            setKey(2);
            expect(reads).toEqual([]);
        });
        return d;
    });
    try
    {
        expect(reads).toEqual([2]);
        expect(requests).toEqual([2]);
    }
    finally
    {
        dispose();
    }
    setKey(3);
    expect(reads).toEqual([2]);
});

it.each([null, false, 0, '', undefined])('retains a successfully fetched %s through a failed refresh, then recovers', async value =>
{
    const server = new GatedServer();
    const [resource, dispose] = createRoot(d => [createResource(async signal =>
    {
        await server.get(signal);
        return value;
    }), d] as const);
    try
    {
        expect([resource.loading(), resource.refreshing()]).toEqual([true, false]);
        await server.releaseGet(0);
        const failing = resource.refetch();
        expect([resource.data(), resource.loading(), resource.refreshing()]).toEqual([value, false, true]);
        (await server.arrived(1)).fail();
        await failing;
        expect(resource.error()).toBeInstanceOf(Error);
        expect([resource.data(), resource.loading(), resource.refreshing()]).toEqual([value, false, false]);
        const recovery = resource.refetch();
        expect([resource.error(), resource.loading(), resource.refreshing()]).toEqual([null, false, true]);
        await server.releaseGet(2);
        await recovery;
        expect(resource.refreshing()).toBe(false);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached', 'cache disabled'] as const)('waits for the surviving request even when the obsolete %s fetch answers early or never', async kind =>
{
    if (kind === 'cache disabled')
    {
        markServerRuntime();
    }
    const server = new GatedServer(1);
    server.ignoreAbort = true;
    const fetch = (signal: AbortSignal): Promise<Cart> => server.get(signal);
    const read = kind === 'plain' ? fetch : cached('resource-overlap-' + kind, fetch);
    const [resource, dispose] = createRoot(d => [createResource(read), d] as const);
    try
    {
        await server.releaseGet(0);
        server.count = 2;
        const first = track(resource.refetch());
        await turns(1);
        const second = track(resource.refetch());
        await turns(1);
        server.count = 3;
        const winner = track(resource.refetch());
        await turns(1);
        expect(server.gets).toHaveLength(4);
        expect(server.gets[1]!.aborted).toBe(true);
        expect(server.gets[2]!.aborted).toBe(true);
        await server.releaseGet(1);
        expect(first.done()).toBe(false);
        expect(resource.data()?.count).toBe(1);
        await server.releaseGet(3);
        expect([first.done(), second.done(), winner.done()]).toEqual([true, true, true]);
        expect([first.failure(), second.failure(), winner.failure()]).toEqual([undefined, undefined, undefined]);
        expect(resource.data()?.count).toBe(3);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached'] as const)('a %s refetch in a key-changing batch waits for only the final key', async kind =>
{
    const server = new GatedServer(1);
    const [key, setKey] = createSignal('old');
    const keys: string[] = [];
    const call = (value: string, signal: AbortSignal): Promise<Cart> =>
    {
        keys.push(value);
        return server.get(signal);
    };
    const fetch = kind === 'plain' ? call : cached('batched-final-key', call);
    const [resource, dispose] = createRoot(d => [createResource(key, fetch), d] as const);
    try
    {
        await server.releaseGet(0);
        server.count = 2;
        let first!: Tracked<void>;
        let second!: Tracked<void>;
        batch(() =>
        {
            first = track(resource.refetch());
            setKey('intermediate');
            second = track(resource.refetch());
            setKey('final');
        });
        await turns(1);
        expect(keys).toEqual(['old', 'final']);
        expect([first.done(), second.done()]).toEqual([false, false]);
        expect([resource.data(), resource.loading(), resource.refreshing()]).toEqual([undefined, true, false]);
        await server.releaseGet(1);
        expect([first.done(), second.done(), resource.data()?.count]).toEqual([true, true, 2]);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached'] as const)('carries the %s waiter across a later key change until the new key succeeds or fails', async kind =>
{
    const server = new GatedServer();
    server.ignoreAbort = true;
    const [key, setKey] = createSignal('a');
    const read = (_key: string, signal: AbortSignal): Promise<Cart> => server.get(signal);
    const [resource, dispose] = createRoot(d => [createResource(key, kind === 'plain' ? read : cached('moving-waiter', read)), d] as const);
    try
    {
        await server.releaseGet(0);
        const pending = track(resource.refetch());
        await server.arrived(1);
        await turns(1);
        setKey('b');
        await server.arrived(2);
        await server.releaseGet(1);
        expect(pending.done()).toBe(false);
        (await server.arrived(2)).fail();
        await turns(1);
        expect(pending.done()).toBe(true);
        expect(pending.failure()).toBeUndefined();
        expect(resource.error()).toBeInstanceOf(Error);
        expect(resource.data()).toBeUndefined();
    }
    finally
    {
        dispose();
    }
});

it('releases pending calls on skip and disposal even if the fetch ignores its signal', async () =>
{
    const [key, setKey] = createSignal<string | false>('one');
    const server = new GatedServer();
    server.ignoreAbort = true;
    const [resource, dispose] = createRoot(d => [createResource(key, (_id, signal) => server.get(signal)), d] as const);
    try
    {
        const first = track(resource.refetch());
        await turns(1);
        setKey(false);
        const skipped = track(resource.refetch());
        await turns(1);
        expect([first.done(), skipped.done(), resource.data(), resource.loading()]).toEqual([true, true, undefined, false]);
        setKey('two');
        const active = track(resource.refetch());
        await turns(1);
        dispose();
        const after = track(resource.refetch());
        await turns(1);
        expect([active.done(), after.done()]).toEqual([true, true]);
        expect(server.gets).toHaveLength(4);
    }
    finally
    {
        dispose();
    }
});

it.each([
    ['plain', 'value'], ['cached', 'value'], ['plain', 'error'], ['cached', 'error']
] as const)('an explicit %s refetch in the construction batch adopts its %s seed and starts once', async (kind, seed) =>
{
    const server = new GatedServer(9);
    const read = (signal: AbortSignal): Promise<Cart> => server.get(signal);
    let pending!: Tracked<void>;
    let resource!: Resource<Cart>;
    const dispose = createRoot(d =>
    {
        batch(() =>
        {
            const options = seed === 'value' ? { initialValue: { count: 5 } } : { initialError: new Error('server seed failed') };
            resource = createResource(kind === 'plain' ? read : cached('batch-seed', read), options);
            pending = track(resource.refetch());
        });
        return d;
    });
    try
    {
        await turns(1);
        expect(server.gets).toHaveLength(1);
        expect([resource.data()?.count, resource.loading(), resource.refreshing()]).toEqual(
            seed === 'value' ? [5, false, true] : [undefined, true, false]
        );
        expect(pending.done()).toBe(false);
        await server.releaseGet(0);
        expect([resource.data()?.count, pending.done()]).toEqual([9, true]);
    }
    finally
    {
        dispose();
    }
});

it.each(['plain', 'cached'] as const)('a %s refetch started by a settling observer has its own promise', async kind =>
{
    const server = new GatedServer(1);
    let later: Tracked<void> | undefined;
    const [resource, dispose] = createRoot(d =>
    {
        const fetch = (signal: AbortSignal): Promise<Cart> => server.get(signal);
        const view = createResource(kind === 'plain' ? fetch : cached('settling-observer', fetch));
        createEffect(() =>
        {
            if (view.data()?.count === 2 && later === undefined)
            {
                server.count = 3;
                later = track(view.refetch());
            }
        });
        return [view, d] as const;
    });
    try
    {
        await server.releaseGet(0);
        server.count = 2;
        const first = track(resource.refetch());
        await server.releaseGet(1);
        expect(server.gets).toHaveLength(3);
        expect([first.done(), later?.done(), resource.data()?.count]).toEqual([true, false, 2]);
        await server.releaseGet(2);
        expect([later?.done(), resource.data()?.count]).toEqual([true, 3]);
    }
    finally
    {
        dispose();
    }
});
