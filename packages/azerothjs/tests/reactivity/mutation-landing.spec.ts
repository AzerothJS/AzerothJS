// @vitest-environment happy-dom
//
// A write the server accepted lands while a fetch of the same entry is on the wire: the fetch may
// answer with data older than the write, so the landing replaces it. No router in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { cached, createEffect, createMutation, createResource, createRoot, createSignal, revalidate, untrack } from 'azerothjs';
import type { CachedFetcher, Mutation } from 'azerothjs';
import type { Cart, Mounted } from '../support/gated-cart.ts';
import { GatedServer, adder, cartFamily, entryOf, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

/** A write that empties table 7 on the server, guessed on its keyed entry, revalidating nothing. */
function clearTable(server: GatedServer, getSeats: CachedFetcher<[number], Cart>): Mutation<undefined, number>
{
    return createMutation
    (
        (_input: undefined, signal: AbortSignal) => server.post(() => 0, signal),
        {
            optimistic: (_input, patch) =>
            {
                patch(getSeats, [7], () => ({ count: 0 }));
            },
            invalidates: []
        }
    );
}

describe('a landing against a fetch of its entry in flight', () =>
{
    it('one add with nothing in flight shows the guess, then the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'one-add');
        const m = mount(getCart);
        await server.releaseGet(0);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await server.drain();
        expect(m.timeline).toEqual([0, 1]);
        expect(m.cart.data()?.count).toBe(1);
        m.dispose();
    });

    it('a revalidate in flight at the click is cancelled at the landing and never shows its answer', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'bg-revalidate');
        const m = mount(getCart);
        await server.releaseGet(0);
        void revalidate(getCart);
        const inFlight = await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        expect(inFlight.aborted).toBe(true);
        inFlight.release();
        await server.drain();
        expect(m.timeline).toEqual([0, 1]);
        expect(m.cart.data()?.count).toBe(1);
        m.dispose();
    });

    it('two quick adds, the second landing while the first run revalidates, never revert', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'two-quick');
        const m = mount(getCart);
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
        expect(m.timeline).toEqual([0, 1, 2]);
        expect(m.cart.data()?.count).toBe(2);
        m.dispose();
    });

    it('two spaced adds end at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'two-spaced');
        const m = mount(getCart);
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

    it('a keyed guess with invalidates: [] keeps the written value over a revalidate in flight', async () =>
    {
        const server = new GatedServer(4);
        const getSeats = cached('gated-keyed-seats', (_table: number, signal: AbortSignal) => server.get(signal));
        let dispose!: () => void;
        const seats = createRoot((d) =>
        {
            dispose = d;
            return createResource(() => 7, getSeats);
        });
        await server.releaseGet(0);
        expect(seats.data()?.count).toBe(4);
        void revalidate(getSeats, [7]);
        const inFlight = await server.arrived(1);
        const run = clearTable(server, getSeats).run(undefined);
        (await server.postArrived(0)).release();
        await run;
        await turns();
        inFlight.release();
        await server.drain();
        expect(seats.data()?.count).toBe(0);
        dispose();
    });

    it('a keyed guess with invalidates: [] and nothing in flight fetches nothing', async () =>
    {
        const server = new GatedServer(4);
        const getSeats = cached('gated-keyed-idle', (_table: number, signal: AbortSignal) => server.get(signal));
        let dispose!: () => void;
        const seats = createRoot((d) =>
        {
            dispose = d;
            return createResource(() => 7, getSeats);
        });
        await server.releaseGet(0);
        const run = clearTable(server, getSeats).run(undefined);
        (await server.postArrived(0)).release();
        await run;
        await server.drain();
        expect(seats.data()?.count).toBe(0);
        expect(server.gets).toHaveLength(1);
        dispose();
    });
});

describe('callers waiting on a fetch a landing supersedes', () =>
{
    it('an awaited revalidate() whose own fetch a landing supersedes resolves at data fetched after the write', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'own-revalidate');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        await until(() => awaited.done(), 'the awaited revalidate');
        expect(atResolve).toBe(6);
        expect(m.cart.data()?.count).toBe(6);
        m.dispose();
    });

    it('an awaited revalidate() over a refetch in flight, interrupted by two landings, resolves at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'two-landings');
        const m = mount(getCart);
        await server.releaseGet(0);
        void m.cart.refetch();
        await server.arrived(1);
        server.count = 5;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        const add = adder(server, getCart);
        const first = add.run({ op: inc });
        (await server.postArrived(0)).release();
        await first;
        await turns();
        const second = add.run({ op: inc });
        (await server.postArrived(1)).release();
        await second;
        await turns();
        await server.drain();
        await until(() => awaited.done(), 'the awaited revalidate');
        expect(atResolve).toBe(7);
        expect(m.cart.data()?.count).toBe(7);
        m.dispose();
    });

    for (const empty of [false, true])
    {
        it(`an awaited refetch() whose forced fetch a landing supersedes resolves at the server value (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `own-refetch-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            server.count = 5;
            let atResolve: number | undefined;
            const awaited = track(m.cart.refetch().then(() =>
            {
                atResolve = m.cart.data()?.count;
            }));
            await server.arrived(1);
            const run = adder(server, getCart, empty ? { invalidates: [] } : {}).run({ op: inc });
            (await server.postArrived(0)).release();
            await run;
            await turns();
            await server.drain();
            await until(() => awaited.done(), 'the awaited refetch');
            expect(atResolve).toBe(6);
            expect(m.cart.data()?.count).toBe(6);
            m.dispose();
        });
    }

    it('with invalidates: [] a refetch() in flight at the landing is replaced, not lost', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'refetch-replaced');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        const forced = track(m.cart.refetch());
        const forcedGet = await server.arrived(1);
        const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        expect(forcedGet.aborted).toBe(true);
        await server.drain();
        await until(() => forced.done(), 'the refetch');
        expect(m.cart.data()?.count).toBe(6);
        expect(server.gets).toHaveLength(3);
        m.dispose();
    });

    it('with invalidates: [] a first load in flight at the landing is replaced, so the page shows the server value', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'first-load');
        const m = mount(getCart);
        const firstLoad = await server.arrived(0);
        const run = adder(server, getCart, { invalidates: [], tolerant: true }).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        expect(firstLoad.aborted).toBe(true);
        await server.drain();
        expect(m.cart.data()?.count).toBe(6);
        m.dispose();
    });

    it('a one-shot read at zero subscribers whose fetch a landing supersedes resolves at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'unsubscribed-read');
        const m = mount(getCart);
        await server.releaseGet(0);
        m.dispose();
        await turns();
        server.count = 5;
        await revalidate(getCart);
        const read = track(getCart());
        await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        await server.drain();
        await until(() => read.done(), 'the one-shot read');
        expect(read.value()?.count).toBe(6);
    });

    it('an awaited revalidate() whose superseded fetcher never answers resolves at the replacement', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'never-answers');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        server.ignoreAbort = true;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        const hung = await server.arrived(1);
        server.ignoreAbort = false;
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        for (let i = 0; i < 20 && !awaited.done(); i++)
        {
            await turns(3);
            for (const get of server.pending())
            {
                if (get !== hung)
                {
                    get.release();
                }
            }
        }
        expect(awaited.done()).toBe(true);
        expect(atResolve).toBe(6);
        m.dispose();
    });

    it('a replacement that fails leaves the folded value with the error, never the pre-write answer', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'replacement-fails');
        const m = mount(getCart);
        await server.releaseGet(0);
        server.count = 5;
        const awaited = track(revalidate(getCart));
        const own = await server.arrived(1);
        const run = adder(server, getCart).run({ op: inc });
        (await server.postArrived(0)).release();
        await run;
        await turns();
        // The call's own read answers what it saw; every read begun after the write fails.
        for (let i = 0; i < 20; i++)
        {
            await turns(3);
            for (const get of server.pending())
            {
                if (get === own)
                {
                    get.release();
                }
                else
                {
                    get.fail();
                }
            }
        }
        expect(awaited.done()).toBe(true);
        expect(m.cart.data()?.count).toBe(1);
        expect(m.cart.error()).not.toBeNull();
        expect(m.timeline).toEqual([0, 1]);
        m.dispose();
    });

    for (const empty of [false, true])
    {
        it(`a fetch begun while the write is out and read before the commit never reverts the landing (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `mid-write-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const run = adder(server, getCart, empty ? { invalidates: [] } : {}).run({ op: inc });
            const post = await server.postArrived(0);
            void m.cart.refetch();
            const mid = await server.arrived(1);
            post.release();
            await run;
            await turns();
            mid.release();
            await turns();
            expect(m.cart.data()?.count).toBe(1);
            await server.drain();
            expect(m.timeline).toEqual([0, 1]);
            expect(m.cart.data()?.count).toBe(1);
            m.dispose();
        });
    }

    it('a landing whose guess cannot read a never-loaded base still replaces the first load a one-shot reader waits on', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'unreadable-base');
        const first = track(getCart());
        const firstLoad = await server.arrived(0);
        const run = track(adder(server, getCart).run({ op: inc }));
        (await server.postArrived(0)).release();
        await until(() => run.done(), 'the run');
        await turns();
        expect(firstLoad.aborted).toBe(true);
        firstLoad.release();
        await server.drain();
        await until(() => first.done(), 'the first read');
        expect(run.failure()).toBeUndefined();
        expect(run.value()?.ok).toBe(false);
        expect(first.value()?.count).toBe(server.count);
    });
});

describe('a landing on an entry with no audience', () =>
{
    for (const empty of [false, true])
    {
        for (const late of ['value', 'error', 'abort'] as const)
        {
            it(`starts no fetch, resolves a pending refetch() and never takes the superseded fetch's late ${ late } (invalidates ${ empty ? '[]' : 'default' })`, async () =>
            {
                const server = new GatedServer(0);
                const getCart = cartFamily(server, `left-before-landing-${ late }-${ String(empty) }`, { fresh: 60_000 });
                const m = mount(getCart);
                await server.releaseGet(0);
                const add = adder(server, getCart, empty ? { invalidates: [] } : {});
                // The forced fetch answers when told, ignoring its abort, except in the abort arm.
                server.ignoreAbort = late !== 'abort';
                const forced = track(m.cart.refetch());
                const superseded = await server.arrived(1);
                server.ignoreAbort = false;
                const run = track(add.run({ op: inc }));
                (await server.postArrived(0)).release();
                // The last subscriber leaves in the task the write answers: the landing runs first,
                // with no audience, and the zero check this queues runs after it.
                m.dispose();
                await until(() => run.done(), 'the run');
                await turns();
                expect(`gets ${ server.gets.length }, aborted ${ String(superseded.aborted) }, resolved ${ String(forced.done()) }`).toBe('gets 2, aborted true, resolved true');
                if (late === 'value')
                {
                    superseded.release();
                }
                else if (late === 'error')
                {
                    superseded.fail();
                }
                await turns();
                expect((entryOf(getCart)?.value as Cart | undefined)?.count).toBe(1);
                expect(entryOf(getCart)?.hasError).toBe(false);
                const again = mount(getCart);
                await turns();
                expect(again.cart.data()?.count).toBe(1);
                expect(again.cart.error()).toBeNull();
                await server.drain();
                expect(again.timeline).toEqual([1]);
                expect(again.cart.data()?.count).toBe(server.count);
                expect((await getCart()).count).toBe(server.count);
                again.dispose();
            });
        }
    }

    for (const empty of [false, true])
    {
        for (const late of ['value', 'error', 'abort'] as const)
        {
            it(`a reader that comes back in the landing's own task never takes the superseded fetch's late ${ late } (invalidates ${ empty ? '[]' : 'default' })`, async () =>
            {
                const server = new GatedServer(0);
                const getCart = cartFamily(server, `back-in-landing-task-${ late }-${ String(empty) }`, { fresh: 60_000 });
                const m = mount(getCart);
                await server.releaseGet(0);
                const add = adder(server, getCart, empty ? { invalidates: [] } : {});
                server.ignoreAbort = late !== 'abort';
                void m.cart.refetch();
                const superseded = await server.arrived(1);
                server.ignoreAbort = false;
                // A view that opens when the run answers mounts its reader before the zero check.
                const [view, setView] = createSignal<Mounted | undefined>(undefined);
                const errors: unknown[] = [];
                let wasPending = false;
                const stopView = createRoot((dispose) =>
                {
                    createEffect(() =>
                    {
                        const pending = add.pending();
                        wasPending ||= pending;
                        if (wasPending && !pending && untrack(view) === undefined)
                        {
                            setView(untrack(() => mount(getCart)));
                        }
                    });
                    // Every error the view shows: a later fetch can clear one before the checks.
                    createEffect(() =>
                    {
                        const error = view()?.cart.error();
                        if (error !== undefined && error !== null)
                        {
                            errors.push(error);
                        }
                    });
                    return dispose;
                });
                const run = track(add.run({ op: inc }));
                (await server.postArrived(0)).release();
                m.dispose();
                await until(() => run.done(), 'the run');
                await turns();
                if (late === 'value')
                {
                    superseded.release();
                }
                else if (late === 'error')
                {
                    superseded.fail();
                }
                await turns();
                await server.drain();
                const again = view();
                expect(again?.timeline).toEqual([1]);
                expect(errors).toEqual([]);
                expect(again?.cart.error()).toBeNull();
                expect(again?.cart.data()?.count).toBe(server.count);
                again?.dispose();
                stopView();
            });
        }
    }
});
