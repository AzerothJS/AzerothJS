// @vitest-environment happy-dom
// A loader stores a direct cached read in its own entry. Only a subscribed resource follows a
// pending guess through rollback. Direct readers instead own their minimum fetch and cancellation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catchError, createEffect, createMemoryHistory, createResource, createRoot, createRouter, onUncaughtError, revalidate } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { GatedServer, adder, cartFamily, entryOf, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import type { Cart } from '../support/gated-cart.ts';

afterEach(() =>
{
    resetDataCache();
});

describe('a direct cached read during an optimistic write', () =>
{
    it('returns the committed value on a hit and on a join, even while a resource shows a guess', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'direct-hit-join');
        const view = mount(getCart);
        try
        {
            await server.releaseGet(0);
            const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
            const post = await server.postArrived(0);
            const hit = await getCart();
            const refresh = revalidate(getCart);
            await server.arrived(1);
            const joined = getCart();
            await server.releaseGet(1);
            await refresh;
            const fromJoin = await joined;
            const displayed = view.cart.data()?.count;
            post.refuse();
            expect((await run).ok).toBe(false);
            expect([hit.count, fromJoin.count, displayed]).toEqual([5, 5, 6]);
            expect(view.cart.data()?.count).toBe(5);
        }
        finally
        {
            view.dispose();
        }
    });

    it('returns a successfully folded write before another fetch', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'direct-after-fold');
        const view = mount(getCart);
        try
        {
            await server.releaseGet(0);
            const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
            (await server.postArrived(0)).release();
            expect((await run).ok).toBe(true);
            expect((await getCart()).count).toBe(6);
            expect(server.gets).toHaveLength(1);
        }
        finally
        {
            view.dispose();
        }
    });

    it('keeps the loader result correct after rollback when the loader reads across an await', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'loader-rollback');
        const view = mount(getCart);
        let disposeRouter: (() => void) | undefined;
        try
        {
            await server.releaseGet(0);
            const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
            const post = await server.postArrived(0);
            expect(view.cart.data()?.count).toBe(6);
            const router = createRoot((dispose) =>
            {
                disposeRouter = dispose;
                return createRouter({
                    history: createMemoryHistory('/'),
                    routes: [{
                        path: '/',
                        component: () => document.createElement('div'),
                        loader: async () =>
                        {
                            await Promise.resolve();
                            return (await getCart()).count;
                        }
                    }]
                });
            });
            const loaded = (): unknown => router.loaders[0]?.data();
            await until(() => loaded() !== undefined, 'the route loader');
            const beforeRollback = loaded();
            post.refuse();
            expect((await run).ok).toBe(false);
            expect([beforeRollback, loaded(), view.cart.data()?.count]).toEqual([5, 5, 5]);
            expect(server.gets).toHaveLength(1);
        }
        finally
        {
            disposeRouter?.();
            view.dispose();
        }
    });
});

describe('one-shot cache reader demand', () =>
{
    it.each(['success', 'failure'] as const)('keeps cold readers through seed adoption and a qualifying fetch (%s)', async (outcome) =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'seed-held-readers', { fresh: Infinity });
        const early = track(getCart());
        const beforeWrite = await server.arrived(0);
        const write = adder(server, getCart, { tolerant: true, invalidates: [] }).run({ op: inc });
        (await server.postArrived(0)).release();
        expect((await write).ok).toBe(true);
        const qualifying = await server.arrived(1);
        expect(beforeWrite.aborted).toBe(true);
        const controller = new AbortController();
        const attached = vi.spyOn(controller.signal, 'addEventListener');
        const detached = vi.spyOn(controller.signal, 'removeEventListener');
        const marked = track(getCart(controller.signal));
        const [view, dispose] = createRoot(d => [createResource(getCart, { initialValue: { count: 8 } }), d] as const);
        try
        {
            await turns(1);
            expect(early.done()).toBe(false);
            expect(marked.done()).toBe(false);
            expect(attached).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
            expect(detached).not.toHaveBeenCalled();
            expect(qualifying.aborted).toBe(false);
            expect(server.gets).toHaveLength(2);
            const provisional = view.data();
            expect(provisional).toBeDefined();
            expect(view.refreshing()).toBe(true);
            if (outcome === 'success')
            {
                await server.releaseGet(1);
                expect([early.value()?.count, marked.value()?.count]).toEqual([6, 6]);
                expect(server.gets).toHaveLength(2);
            }
            else
            {
                qualifying.fail();
                await until(() => early.done() && marked.done(), 'the failed qualifying read');
                expect(marked.failure()).toBeInstanceOf(Error);
                expect(marked.failure()).toBe(early.failure());
                expect(view.error()).toBe(marked.failure());
                expect(view.data()).toEqual(provisional);
                expect(server.gets).toHaveLength(2);
                const retry = getCart();
                await server.releaseGet(2);
                expect((await retry).count).toBe(6);
                expect(server.gets).toHaveLength(3);
            }
            expect(view.data()?.count).toBe(6);
            expect(view.error()).toBeNull();
            expect(detached).toHaveBeenCalledWith('abort', attached.mock.calls[0]![1]);
        }
        finally
        {
            dispose();
        }
    });

    it('finishes eligible readers and renews dependent entries before reporting an escaped fetch observer error', async () =>
    {
        const server = new GatedServer(0);
        const childServer = new GatedServer(10);
        const getCart = cartFamily(server, 'throwing-parent');
        const getChild = cartFamily(childServer, 'dependent-child');
        const view = mount(getCart);
        const child = mount(getChild);
        const sentinel = new Error('the parent observer failed');
        const reported: { error: unknown; parentGets: number; childGets: number }[] = [];
        const seen: unknown[] = [];
        const unregister = onUncaughtError(error => reported.push({ error, parentGets: server.gets.length, childGets: childServer.gets.length }));
        let disposeObserver: (() => void) | undefined;
        try
        {
            await server.releaseGet(0);
            await childServer.releaseGet(0);
            const parentEntry = entryOf(getCart)!;
            const childEntry = entryOf(getChild)!;
            // The same dependency recorded by a router loader that awaited its parent.
            childEntry.parentKey = parentEntry.key;
            childEntry.usedParent = true;
            disposeObserver = createRoot(dispose =>
            {
                catchError(() => createEffect(() =>
                {
                    parentEntry.version();
                    if (seen.length === 0 && (parentEntry.value as Cart).count === 3)
                    {
                        throw sentinel;
                    }
                }), error =>
                {
                    seen.push(error);
                    throw sentinel;
                });
                return dispose;
            });
            server.count = 3;
            const refetch = track(view.cart.refetch());
            await server.arrived(1);
            const early = track(getCart());
            server.count = 5;
            childServer.count = 12;
            const marked = track(revalidate(getCart));
            const late = track(getCart());
            await server.releaseGet(1);
            expect(seen).toEqual([sentinel]);
            expect(reported).toEqual([{ error: sentinel, parentGets: 3, childGets: 2 }]);
            expect(refetch.done()).toBe(true);
            expect(early.value()?.count).toBe(3);
            expect(marked.done()).toBe(false);
            expect(late.done()).toBe(false);
            await server.releaseGet(2);
            await childServer.releaseGet(1);
            expect(marked.done()).toBe(true);
            expect(late.value()?.count).toBe(5);
            expect(child.cart.data()?.count).toBe(12);
        }
        finally
        {
            disposeObserver?.();
            unregister();
            child.dispose();
            view.dispose();
        }
    });

    it('lets an earlier reader finish and holds later readers for one fetch after the mark', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'direct-post-mark');
        const early = getCart();
        await server.arrived(0);
        server.count = 5;
        await revalidate(getCart);
        expect(server.gets).toHaveLength(1);
        const late = track(getCart());
        const alsoLate = track(getCart());
        await server.releaseGet(0);
        expect((await early).count).toBe(0);
        expect(late.done()).toBe(false);
        expect(alsoLate.done()).toBe(false);
        await server.releaseGet(1);
        expect([late.value()?.count, alsoLate.value()?.count]).toEqual([5, 5]);
        expect(server.gets).toHaveLength(2);
    });

    it('withdraws a cancelled post-mark demand without forcing a fetch for the earlier reader', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'direct-cancel-mark');
        const early = getCart();
        const firstGet = await server.arrived(0);
        await revalidate(getCart);
        const controller = new AbortController();
        const late = track(getCart(controller.signal));
        const reason = new Error('left after the mark');
        controller.abort(reason);
        await turns(1);
        expect(late.failure()).toBe(reason);
        expect(firstGet.aborted).toBe(false);
        await server.releaseGet(0);
        expect((await early).count).toBe(0);
        expect(server.gets).toHaveLength(1);
    });

    it('rejects only the cancelled reader and keeps the shared fetch alive', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'direct-cancel-one');
        const controller = new AbortController();
        const reason = new Error('reader left');
        const leaving = track(getCart(controller.signal));
        const staying = track(getCart());
        const request = await server.arrived(0);
        controller.abort(reason);
        await turns(1);
        expect(leaving.failure()).toBe(reason);
        expect(request.aborted).toBe(false);
        expect(staying.done()).toBe(false);
        await server.releaseGet(0);
        expect(staying.value()?.count).toBe(5);
        expect(server.gets).toHaveLength(1);
    });

    it('rejects the last reader with its reason and aborts the unowned fetch', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'direct-cancel-last');
        const controller = new AbortController();
        const reason = new Error('last reader left');
        const leaving = track(getCart(controller.signal));
        const request = await server.arrived(0);
        controller.abort(reason);
        await turns(1);
        expect(leaving.failure()).toBe(reason);
        expect(request.aborted).toBe(true);
        server.count = 8;
        const next = getCart();
        await server.releaseGet(1);
        expect((await next).count).toBe(8);
    });

    it('rejects an already-aborted call on a cold or fresh entry without starting a fetch', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'direct-pre-abort');
        const reason = new Error('already left');
        const controller = new AbortController();
        controller.abort(reason);
        const cold = track(getCart(controller.signal));
        await turns(1);
        expect(cold.failure()).toBe(reason);
        expect(server.gets).toHaveLength(0);
        const first = getCart();
        await server.releaseGet(0);
        await first;
        await expect(getCart(controller.signal)).rejects.toBe(reason);
        expect(server.gets).toHaveLength(1);
    });
});
