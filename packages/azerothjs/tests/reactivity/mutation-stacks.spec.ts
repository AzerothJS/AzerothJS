// @vitest-environment happy-dom
//
// Stacked guesses whose runs land out of order: a confirmed guess gives way to data fetched after
// its landing, and never strands when the run below it fails. No router in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { revalidate } from 'azerothjs';
import { GatedServer, add10, adder, cartFamily, double, entryOf, inc, mount, parallelPair, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

describe('two parallel runs, the second-called landing first', () =>
{
    it('with invalidates: [] both adds show and nothing goes above them', async () =>
    {
        const r = await parallelPair({ tag: 'pair-empty', start: 0, slow: inc, fast: inc, slowOutcome: 'ok', empty: true });
        expect(r.timeline).toEqual([0, 1, 2]);
    });

    it('under the default invalidation the confirmed add is never counted twice over refetched data', async () =>
    {
        const r = await parallelPair({ tag: 'pair-default', start: 0, slow: inc, fast: inc, slowOutcome: 'ok' });
        expect(Math.max(...r.timeline)).toBeLessThanOrEqual(2);
        expect(r.final).toBe(2);
    });

    it('when the slow run fails after the fast one landed the page ends at the server value', async () =>
    {
        const r = await parallelPair({ tag: 'slow-fails', start: 0, slow: inc, fast: inc, slowOutcome: 'fail' });
        expect(r.slow).toBe('failed');
        expect(r.final).toBe(r.server);
    });

    it('when the slow run is cancelled after the fast one landed the page ends at the server value', async () =>
    {
        const r = await parallelPair({ tag: 'slow-cancelled', start: 0, slow: inc, fast: inc, slowOutcome: 'cancel' });
        expect(r.slow).toBe('cancelled');
        expect(r.final).toBe(r.server);
    });

    it('a slow run that fails below a confirmed one leaves no guess an explicit revalidate cannot clear', async () =>
    {
        const r = await parallelPair({ tag: 'fails-then-revalidate', start: 0, slow: inc, fast: inc, slowOutcome: 'fail', explicitRevalidate: true });
        expect(r.afterExplicitRevalidate).toBe(r.server);
    });

    it('a slow run cancelled below a confirmed one leaves no guess an explicit revalidate cannot clear', async () =>
    {
        const r = await parallelPair({ tag: 'cancel-then-revalidate', start: 0, slow: inc, fast: inc, slowOutcome: 'cancel', explicitRevalidate: true });
        expect(r.afterExplicitRevalidate).toBe(r.server);
    });

    it('with invalidates: [] a foreign refetch between the landings never folds the add in twice', async () =>
    {
        const r = await parallelPair({ tag: 'empty-foreign', start: 0, slow: inc, fast: inc, slowOutcome: 'ok', empty: true, foreign: true });
        expect(Math.max(...r.timeline)).toBeLessThanOrEqual(2);
        expect(r.final).toBe(2);
    });

    it('non-commuting writes under the default invalidation never show a value no order produces', async () =>
    {
        // From 1: call order gives 12, the server's completion order gives 22.
        const r = await parallelPair({ tag: 'non-commuting', start: 1, slow: double, fast: add10, slowOutcome: 'ok' });
        expect(r.server).toBe(22);
        expect(r.final).toBe(22);
        expect(r.timeline.every((v) => [1, 2, 12, 22].includes(v))).toBe(true);
    });

    it('non-commuting writes with invalidates: [] keep the call-order value until something revalidates', async () =>
    {
        const r = await parallelPair({ tag: 'non-commuting-empty', start: 1, slow: double, fast: add10, slowOutcome: 'ok', empty: true });
        expect(r.final).toBe(12);
        expect(r.server).toBe(22);
    });

    it('with invalidates: [] a slow write the server applied first, then a foreign refetch, ends at the server value', async () =>
    {
        const r = await parallelPair({ tag: 'commits-first', start: 0, slow: inc, fast: inc, slowOutcome: 'ok', empty: true, foreign: true, slowCommitsFirst: true });
        expect(r.final).toBe(r.server);
    });

    for (const empty of [false, true])
    {
        it(`a held-back landing supersedes a fetch begun before it that answers after the fast commit (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `held-back-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const add = adder(server, getCart, empty ? { invalidates: [] } : {});
            const slow = add.run({ op: inc });
            const fast = add.run({ op: inc });
            void revalidate(getCart);
            const inFlight = await server.arrived(1);
            (await server.postArrived(1)).release();
            await fast;
            // The server read the fetch after it applied the fast write, so the answer holds it.
            inFlight.releaseNow();
            await turns();
            await server.drain();
            (await server.postArrived(0)).release();
            await slow;
            await turns();
            await server.drain();
            expect(m.cart.data()?.count).toBe(server.count);
            expect(Math.max(...m.timeline)).toBeLessThanOrEqual(2);
            m.dispose();
        });
    }
});

describe('one run over data that settled while its write was on the wire', () =>
{
    it('with invalidates: [] a refetch that read the committed write is fetched again after the landing', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'suspect-base');
        const m = mount(getCart);
        await server.releaseGet(0);
        const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        const post = await server.postArrived(0);
        post.commit();
        void m.cart.refetch();
        await server.drain();
        post.release();
        await run;
        await turns();
        await server.drain();
        expect(m.cart.data()?.count).toBe(server.count);
        m.dispose();
    });

    for (const committed of [false, true])
    {
        it(`a suspect landing whose only reader was answered in its task starts no fetch and keeps the mark (read ${ committed ? 'after' : 'before' } the commit)`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `answered-reader-${ String(committed) }`);
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
            const read = track(getCart());
            const readGet = await server.arrived(1);
            // One task: the read settles, then the write lands, before the reader lets go.
            readGet.release();
            post.release();
            await turns();
            await run;
            await turns(3);
            expect(read.done()).toBe(true);
            expect(server.gets).toHaveLength(2);
            expect(server.aborted()).toBe(0);
            expect(entryOf(getCart)?.stale).toBe(true);
            const next = track(getCart());
            await server.drain();
            await until(() => next.done(), 'the next read');
            expect(next.value()?.count).toBe(server.count);
        });
    }

    it('one run patching an entry twice lands once: one fetch superseded, one replacement', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'patched-twice');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        await server.arrived(1);
        const run = adder(server, getCart, { twice: true }).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        expect(server.gets).toHaveLength(3);
        expect(server.aborted()).toBe(1);
        await server.drain();
        await until(() => awaited.done(), 'the awaited revalidate');
        expect(atResolve).toBe(7);
        expect(m.cart.data()?.count).toBe(7);
        m.dispose();
    });
});
