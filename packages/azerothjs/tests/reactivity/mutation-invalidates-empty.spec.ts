// @vitest-environment happy-dom
//
// invalidates: [] skips a mutation's own revalidation, but its landing still keeps the patched
// entry consistent with the write. No router in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { revalidate } from 'azerothjs';
import { GatedServer, adder, cartFamily, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

describe('invalidates: [] at a landing', () =>
{
    it('with nothing in flight or settling during the write fetches nothing', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'quiet');
        const m = mount(getCart);
        await server.releaseGet(0);
        const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        expect(m.cart.data()?.count).toBe(1);
        expect(server.gets).toHaveLength(1);
        m.dispose();
    });

    it('replaces a refetch in flight and ends at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'refetch-in-flight');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        void m.cart.refetch();
        const forced = await server.arrived(1);
        const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        expect(forced.aborted).toBe(true);
        await server.drain();
        expect(m.cart.data()?.count).toBe(6);
        expect(server.gets).toHaveLength(3);
        m.dispose();
    });

    for (const committed of [true, false])
    {
        const read = committed ? 'after' : 'before';

        it(`fetches once more, with a subscriber, a refetch that settled during the write (read ${ read } the commit)`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `settled-subscribed-${ read }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
            const post = await server.postArrived(0);
            if (committed)
            {
                post.commit();
            }
            void m.cart.refetch();
            (await server.arrived(1)).release();
            await turns();
            post.release();
            await run;
            await turns();
            await server.drain();
            expect(m.cart.data()?.count).toBe(server.count);
            expect(server.gets).toHaveLength(3);
            m.dispose();
        });

        it(`marks for the next reader, with no subscriber, data that settled during the write (read ${ read } the commit)`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `settled-unsubscribed-${ read }`);
            const first = track(getCart());
            await server.releaseGet(0);
            await until(() => first.done(), 'the first read');
            await revalidate(getCart);
            const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
            const post = await server.postArrived(0);
            if (committed)
            {
                post.commit();
            }
            const during = track(getCart());
            (await server.arrived(1)).release();
            await until(() => during.done(), 'the read during the write');
            post.release();
            await run;
            await turns();
            expect(server.gets).toHaveLength(2);
            const next = track(getCart());
            await server.drain();
            await until(() => next.done(), 'the next read');
            expect(next.value()?.count).toBe(server.count);
            expect(server.gets).toHaveLength(3);
        });
    }
});
