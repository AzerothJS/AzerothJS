// @vitest-environment happy-dom
//
// revalidate() while a fetch of the same entry is in flight, with no router anywhere in the file:
// a subscribed entry waits for data fetched after the call, an unsubscribed one is only marked.
import { afterEach, describe, expect, it } from 'vitest';
import { revalidate } from 'azerothjs';
import { GatedServer, cartFamily, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

describe('revalidate() with a fetch in flight, no router', () =>
{
    for (const inFlight of [false, true])
    {
        it(`after a direct server write resolves at the written value (a fetch in flight: ${ String(inFlight) })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `direct-write-${ String(inFlight) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            if (inFlight)
            {
                void revalidate(getCart);
                await server.arrived(1);
            }
            server.count = 1;
            let atResolve: number | undefined;
            const awaited = track(revalidate(getCart).then(() =>
            {
                atResolve = m.cart.data()?.count;
            }));
            await turns();
            expect(awaited.done()).toBe(false);
            await server.drain();
            await until(() => awaited.done(), 'revalidate');
            expect(atResolve).toBe(1);
            expect(m.cart.data()?.count).toBe(1);
            m.dispose();
        });
    }

    it('with no write during the first fetch waits for the follow-up and resolves at its data', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'first-fetch');
        const m = mount(getCart);
        await server.arrived(0);
        server.count = 3;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        await turns();
        expect(awaited.done()).toBe(false);
        await server.drain();
        await until(() => awaited.done(), 'revalidate');
        expect(atResolve).toBe(3);
        expect(server.gets).toHaveLength(2);
        m.dispose();
    });

    it('at zero subscribers marks and returns at once; the read in flight answers its own fetch, the next read fetches', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'zero-subscribers');
        const inFlight = track(getCart());
        await server.arrived(0);
        server.count = 5;
        const awaited = track(revalidate(getCart));
        await turns();
        expect(awaited.done()).toBe(true);
        expect(server.gets).toHaveLength(1);
        const joined = track(getCart());
        await server.drain();
        await until(() => inFlight.done() && joined.done(), 'the reads');
        expect(inFlight.value()?.count).toBe(0);
        expect(joined.value()?.count).toBe(0);
        const next = track(getCart());
        await server.drain();
        await until(() => next.done(), 'the next read');
        expect(next.value()?.count).toBe(5);
        expect(server.gets).toHaveLength(2);
    });
});
