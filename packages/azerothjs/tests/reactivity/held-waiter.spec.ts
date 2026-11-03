// @vitest-environment happy-dom
//
// A one-shot read holds a waiter, and a held waiter is an audience: the last subscriber leaving
// keeps the fetch the read waits on, and a retention window ending meanwhile keeps its entry.
import { afterEach, describe, expect, it } from 'vitest';
import { GatedServer, cartFamily, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

describe('the last subscriber leaving', () =>
{
    it('keeps the fetch a one-shot read waits on', async () =>
    {
        const server = new GatedServer(3);
        const getCart = cartFamily(server, 'leave-during-read');
        const m = mount(getCart);
        const first = await server.arrived(0);
        const read = track(getCart());
        m.dispose();
        await turns();
        expect(first.aborted).toBe(false);
        expect(read.done()).toBe(false);
        first.release();
        await until(() => read.done(), 'the one-shot read');
        expect(read.value()?.count).toBe(3);
    });

    it('with no reader aborts the fetch', async () =>
    {
        const server = new GatedServer(3);
        const getCart = cartFamily(server, 'leave-alone');
        const m = mount(getCart);
        const first = await server.arrived(0);
        m.dispose();
        await turns();
        expect(first.aborted).toBe(true);
    });
});

describe('a retention window', () =>
{
    it('that ends while a one-shot read waits evicts nothing', async () =>
    {
        const server = new GatedServer(4);
        const getCart = cartFamily(server, 'window-during-read', { retain: 0, fresh: Infinity });
        const read = track(getCart());
        const first = await server.arrived(0);
        // The window the read armed when it made the entry ends during these hops.
        await turns();
        expect(read.done()).toBe(false);
        first.release();
        await until(() => read.done(), 'the one-shot read');
        expect(read.value()?.count).toBe(4);
    });

    it('evicts the entry once nothing holds it', async () =>
    {
        const server = new GatedServer(4);
        const getCart = cartFamily(server, 'window-after-read', { retain: 0, fresh: Infinity });
        const read = track(getCart());
        (await server.arrived(0)).release();
        await until(() => read.done(), 'the first read');
        await turns();
        track(getCart());
        await turns();
        expect(server.gets).toHaveLength(2);
    });

    it('left at its default keeps the entry for the next read', async () =>
    {
        const server = new GatedServer(4);
        const getCart = cartFamily(server, 'default-window', { fresh: Infinity });
        const read = track(getCart());
        (await server.arrived(0)).release();
        await until(() => read.done(), 'the first read');
        await turns();
        const next = track(getCart());
        await turns();
        expect(server.gets).toHaveLength(1);
        expect(next.value()?.count).toBe(4);
    });
});
