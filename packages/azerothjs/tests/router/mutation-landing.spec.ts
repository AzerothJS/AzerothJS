// @vitest-environment happy-dom
//
// A write that lands while a fetch of its entry is on the wire, in an app with a router: nothing
// the router does may keep a pre-write answer on screen once the server holds the write.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRoot, createRouter, revalidate } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { GatedServer, adder, cartFamily, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

function beside(): void
{
    const routes: Route[] = [{ path: '/', component: () => document.createElement('div') }];
    createRouter({ routes, history: createMemoryHistory('/') });
}

/** Two quick adds, the second landing while the first run's revalidation is on the wire. */
async function twoQuickAdds(server: GatedServer, tag: string): Promise<{ timeline: number[]; final: number | undefined; afterNextFetch: number | undefined }>
{
    const getCart = cartFamily(server, tag);
    const m = mount(getCart, beside);
    await server.releaseGet(0);
    const add = adder(server, getCart);
    const first = add.run({ op: inc });
    (await server.postArrived(0)).release();
    await first;
    const revalidation = await server.arrived(1);
    const second = add.run({ op: inc });
    (await server.postArrived(1)).release();
    await second;
    await turns();
    revalidation.release();
    await server.drain();
    const final = m.cart.data()?.count;
    const next = revalidate(getCart);
    await server.drain();
    await next;
    const out = { timeline: [...m.timeline], final, afterNextFetch: m.cart.data()?.count };
    m.dispose();
    return out;
}

describe('a landing against a fetch of its entry in flight, with a router', () =>
{
    it('one add with nothing in flight shows the guess, then the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'one-add');
        const m = mount(getCart, beside);
        await server.releaseGet(0);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await server.drain();
        expect(m.timeline).toEqual([0, 1]);
        m.dispose();
    });

    it('a revalidate in flight at the click never shows its pre-write answer', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'bg-revalidate');
        const m = mount(getCart, beside);
        await server.releaseGet(0);
        void revalidate(getCart);
        const inFlight = await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        inFlight.release();
        await server.drain();
        expect(m.timeline).toEqual([0, 1]);
        expect(m.cart.data()?.count).toBe(1);
        m.dispose();
    });

    it('two quick adds show the server value without waiting for the entry\'s next fetch', async () =>
    {
        const server = new GatedServer(0);
        const r = await twoQuickAdds(server, 'two-quick');
        expect(r.timeline).toEqual([0, 1, 2]);
        expect(r.final).toBe(server.count);
        expect(r.afterNextFetch).toBe(server.count);
    });

    it('two spaced adds end at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'two-spaced');
        const m = mount(getCart, beside);
        await server.releaseGet(0);
        const add = adder(server, getCart);
        const first = add.run({ op: inc });
        (await server.postArrived(0)).release();
        await first;
        await server.drain();
        const second = add.run({ op: inc });
        (await server.postArrived(1)).release();
        await second;
        await server.drain();
        expect(m.timeline).toEqual([0, 1, 2]);
        m.dispose();
    });

    it('a server that reads the count when it answers shows two quick adds right too', async () =>
    {
        const server = new GatedServer(0, true);
        const r = await twoQuickAdds(server, 'read-at-answer');
        expect(r.final).toBe(server.count);
    });

    it('a loader\'s one-shot read at zero subscribers that a landing supersedes returns the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'loader-read');
        const routes: Route[] = [{
            path: '/',
            component: () => document.createElement('div'),
            loader: async () => (await getCart()).count
        }];
        let dispose!: () => void;
        let router!: Router;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history: createMemoryHistory('/') });
        });
        const level = (): unknown => router.loaders[0]?.data();
        await server.releaseGet(0);
        await until(() => level() === 0, 'the first loader value');
        server.count = 5;
        await revalidate(getCart);
        let atResolve: unknown;
        const awaited = track(router.revalidate().then(() =>
        {
            atResolve = level();
        }));
        await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        await until(() => awaited.done(), 'router.revalidate()');
        expect(atResolve).toBe(6);
        expect(level()).toBe(6);
        dispose();
    });
});
