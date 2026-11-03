// @vitest-environment happy-dom
//
// A mutation's own revalidation after its landing: it joins a fetch begun after the write, which
// already carries it, and marks one begun before. No router in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { createEffect, createMutation, createRoot, revalidate } from 'azerothjs';
import { GatedServer, adder, cartFamily, inc, mount, turns } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

describe('a mutation revalidating what it wrote', () =>
{
    it('joins the fetch the landing started instead of fetching again', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'joins');
        const m = mount(getCart);
        await server.releaseGet(0);
        void revalidate(getCart);
        await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        expect(m.timeline).toEqual([0, 1]);
        expect(m.cart.data()?.count).toBe(1);
        expect(server.gets).toHaveLength(3);
        m.dispose();
    });

    it('marks a declared family whose fetch began before the write, so it is fetched again', async () =>
    {
        const other = new GatedServer(0);
        const getOther = cartFamily(other, 'declared');
        const m = mount(getOther);
        await other.releaseGet(0);
        void m.cart.refetch();
        await other.arrived(1);
        const write = async (): Promise<number> =>
        {
            other.count += 1;
            return other.count;
        };
        await createMutation(write, { invalidates: [getOther] }).run(undefined);
        await turns();
        await other.drain();
        expect(m.cart.data()?.count).toBe(1);
        expect(other.gets).toHaveLength(3);
        m.dispose();
    });

    it('at zero subscribers the join still marks, so a later reader inside the fresh window fetches', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'zero-join-cart');
        const recServer = new GatedServer(10);
        const getRecs = cartFamily(recServer, 'zero-join-recs', { fresh: 60_000 });
        const m = mount(getCart);
        await server.releaseGet(0);
        const panel = mount(getRecs);
        await recServer.releaseGet(0);
        let armed = false;
        let disposeWatch!: () => void;
        // In the landing's own flush the recs panel refetches and unmounts, so the revalidation
        // finds a recs fetch begun after the write with nobody subscribed.
        createRoot((d) =>
        {
            disposeWatch = d;
            createEffect(() =>
            {
                m.cart.data();
                if (armed)
                {
                    armed = false;
                    void panel.cart.refetch().catch(() => undefined);
                    panel.dispose();
                }
            });
        });
        const run = adder(server, getCart, { invalidates: [getCart, getRecs] }).run({ op: inc });
        await turns();
        armed = true;
        recServer.count = 11;
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        await recServer.drain();
        const later = mount(getRecs);
        await turns();
        await recServer.drain();
        expect(later.cart.data()?.count).toBe(11);
        later.dispose();
        disposeWatch();
        m.dispose();
    });
});
