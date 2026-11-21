// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cached, createMutation, createResource, createRoot, revalidate } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import type { Cart } from '../support/gated-cart.ts';
import { GatedServer, adder, cartFamily, entryOf, inc, mount, track, until } from '../support/gated-cart.ts';

afterEach(() =>
{
    resetDataCache();
});

it('sends both cold writes and applies their guesses only after a base arrives', async () =>
{
    const server = new GatedServer(5);
    const getCart = cartFamily(server, 'cold-clicks');
    const view = mount(getCart);
    const add = adder(server, getCart);
    const first = track(add.run({ op: inc }));
    const second = track(add.run({ op: inc }));
    expect(server.posts).toHaveLength(2);
    expect(view.cart.loading()).toBe(true);
    expect(view.cart.data()).toBeUndefined();
    await server.releaseGet(0);
    expect(view.cart.data()).toEqual({ count: 7 });
    server.posts[1]!.release();
    server.posts[0]!.release();
    await until(() => first.done() && second.done(), 'both writes');
    expect([first.value()?.ok, second.value()?.ok]).toEqual([true, true]);
    const refreshed = revalidate(getCart);
    await server.drain();
    await refreshed;
    expect(server.count).toBe(7);
    expect(view.cart.data()).toEqual({ count: 7 });
    expect(entryOf(getCart)?.layers).toHaveLength(0);
    view.dispose();
});

it('keeps a failed first load empty until a later write fetches a usable base', async () =>
{
    const server = new GatedServer(5);
    const getCart = cartFamily(server, 'cold-recover');
    const view = mount(getCart);
    (await server.arrived(0)).fail();
    await until(() => view.cart.error() !== null, 'first load failure');
    const write = track(adder(server, getCart, { invalidates: [] }).run({ op: inc }));
    expect(server.posts).toHaveLength(1);
    server.posts[0]!.release();
    await until(() => write.done(), 'accepted write');
    expect(write.value()?.ok).toBe(true);
    expect(view.cart.data()).toBeUndefined();
    await server.drain();
    expect(view.cart.data()).toEqual({ count: 6 });
    expect(view.cart.error()).toBeNull();
    view.dispose();
});

it('adopts the first seed and reconciles an earlier accepted write even with no invalidation targets', async () =>
{
    const server = new GatedServer(5);
    const getCart = cartFamily(server, 'seed-after-landing', { fresh: Infinity });
    const write = track(adder(server, getCart, { invalidates: [] }).run({ op: inc }));
    (await server.postArrived(0)).release();
    await until(() => write.done(), 'accepted write');
    expect(write.value()?.ok).toBe(true);
    expect(entryOf(getCart)?.hasValue).toBe(false);
    expect(server.gets).toHaveLength(0);
    const [view, dispose] = createRoot(d => [createResource(getCart, { initialValue: { count: 6 } }), d] as const);
    expect(entryOf(getCart)?.value).toEqual({ count: 6 });
    await server.releaseGet(0);
    expect(view.data()).toEqual({ count: 6 });
    expect(entryOf(getCart)?.layers).toHaveLength(0);
    dispose();
});

it('keeps revalidation live when a pending projection refuses a newly fetched value', async () =>
{
    const server = new GatedServer(5);
    const getCart = cached('projection-revalidation', async (signal: AbortSignal): Promise<Cart | null> =>
    {
        const cart = await server.get(signal);
        return cart.count === 0 ? null : cart;
    });
    const [view, dispose] = createRoot(d => [createResource(getCart), d] as const);
    await server.releaseGet(0);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refusal = new Error('no cart to project');
    const write = createMutation((_input: undefined, signal: AbortSignal) => server.post(inc, signal), {
        optimistic: (_input, patch) => patch(getCart, cart =>
        {
            if (cart === null)
            {
                throw refusal;
            }
            return { count: cart.count + 1 };
        })
    });
    const run = track(write.run(undefined));
    expect(view.data()).toEqual({ count: 6 });
    server.count = 0;
    const first = track(view.refetch());
    const refresh = track(revalidate(getCart));
    await server.releaseGet(1);
    expect(view.data()).toBeNull();
    expect(first.done()).toBe(true);
    expect(refresh.done()).toBe(false);
    await server.releaseGet(2);
    expect(refresh.done()).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('projection-revalidation'), refusal);
    server.posts[0]!.release();
    await until(() => run.done(), 'accepted write');
    expect(run.value()?.ok).toBe(true);
    expect(write.error()).toBeNull();
    await server.drain();
    expect(view.data()).toEqual({ count: 1 });
    dispose();
});

it('lands every patched entry even when the first confirmed projection refuses its base', async () =>
{
    const cart = cached('multi-refusing', async (): Promise<number | null> => null);
    const count = cached('multi-readable', async () => 4);
    await Promise.all([cart(), count()]);
    const write = createMutation(async () => 'saved', {
        optimistic: (_input: undefined, patch) =>
        {
            patch(cart, value =>
            {
                if (value === null)
                {
                    throw new Error('no cart');
                }
                return value + 1;
            });
            patch(count, value => value + 1);
        },
        invalidates: []
    });
    expect(await write.run(undefined)).toEqual({ ok: true, data: 'saved' });
    expect(await count()).toBe(5);
    expect(entryOf(cart)?.stale).toBe(true);
    expect(entryOf(count)?.layers).toHaveLength(0);
});

it('projects over a fetched undefined and lets a later layer use the last readable value', async () =>
{
    const getCount = cached('projection-undefined', async (): Promise<number | undefined> => undefined);
    const [view, dispose] = createRoot(d => [createResource(getCount), d] as const);
    await until(() => !view.loading(), 'the fetched undefined');
    const server = new GatedServer(0);
    const increment = createMutation((_strict: boolean, signal: AbortSignal) => server.post(inc, signal), {
        optimistic: (strict, patch) => patch(getCount, value =>
        {
            if (strict && value === undefined)
            {
                throw new Error('a count is required');
            }
            return (value ?? 0) + 1;
        })
    });
    const first = increment.run(true);
    const second = increment.run(false);
    expect(view.data()).toBe(1);
    (await server.postArrived(0)).refuse();
    expect(await first).toMatchObject({ ok: false, error: new Error('the server refused the write') });
    expect(view.data()).toBe(1);
    (await server.postArrived(1)).release();
    expect(await second).toEqual({ ok: true, data: 1 });
    dispose();
});

it('leaves no guesses from a declaration that throws after its first patch', async () =>
{
    const server = new GatedServer(5);
    const getCart = cartFamily(server, 'partial-declaration');
    const view = mount(getCart);
    await server.releaseGet(0);
    const failure = new Error('invalid declaration');
    const add = createMutation((_input: undefined, signal: AbortSignal) => server.post(inc, signal), {
        optimistic: (_input, patch) =>
        {
            patch(getCart, cart => ({ count: cart.count + 1 }));
            throw failure;
        }
    });
    await expect(add.run(undefined)).rejects.toBe(failure);
    expect(server.posts).toHaveLength(0);
    expect(view.timeline).toEqual([5]);
    expect(entryOf(getCart)?.layers).toHaveLength(0);
    view.dispose();
});

it('starts no replacement fetch when the only reader aborts in the task a write answers', async () =>
{
    const server = new GatedServer(5);
    const getCart = cartFamily(server, 'abort-at-landing');
    const write = adder(server, getCart, { invalidates: [] }).run({ op: inc });
    const caller = new AbortController();
    const read = track(getCart(caller.signal));
    const first = await server.arrived(0);
    const post = await server.postArrived(0);
    post.release();
    caller.abort();
    expect((await write).ok).toBe(true);
    await until(() => read.done(), 'the aborted read');
    expect(read.failure()).toBe(caller.signal.reason);
    expect(first.aborted).toBe(true);
    expect(server.gets).toHaveLength(1);
});

it('rejects an aborted direct read when its fetcher synchronously seeds its own entry', async () =>
{
    const caller = new AbortController();
    const reason = new Error('reader left before seed adoption');
    let dispose: (() => void) | undefined;
    const getCart = cached('abort-before-seed', (): Promise<number> =>
    {
        caller.abort(reason);
        createRoot(d =>
        {
            dispose = d;
            createResource(getCart, { initialValue: 5 });
        });
        return Promise.resolve(6);
    });
    try
    {
        await expect(getCart(caller.signal)).rejects.toBe(reason);
        expect(await getCart()).toBe(5);
    }
    finally
    {
        dispose?.();
    }
});
