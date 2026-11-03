// @vitest-environment happy-dom
//
// A fold that completes restarts the entry's freshness window, at a landing and at a drop; one that
// folds nothing or stops at a guess which cannot read the value restarts nothing. No router here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartFetcher } from '../support/gated-cart.ts';
import { GatedServer, adder, cartFamily, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

const FRESH = 1000;

afterEach(() =>
{
    vi.restoreAllMocks();
    resetDataCache();
});

/** Adds one to an empty cart and throws over any other, as a guess over a shape it cannot read. */
function fromEmpty(n: number): number
{
    if (n >= 1)
    {
        throw new TypeError('this guess reads only an empty cart');
    }
    return n + 1;
}

/** A base fetched at the mocked clock's start, with a freshness window of FRESH. */
async function fetchedBase(server: GatedServer, tag: string): Promise<{ clock: { now: number }; getCart: CartFetcher }>
{
    const clock = { now: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const getCart = cartFamily(server, tag, { fresh: FRESH });
    const first = track(getCart());
    await server.releaseGet(0);
    await until(() => first.done(), 'the first read');
    return { clock, getCart };
}

/** Mounts a reader from zero and counts the GETs that mount starts. */
async function mountedGets(server: GatedServer, getCart: CartFetcher): Promise<{ gets: number; timeline: number[] }>
{
    const before = server.gets.length;
    const m = mount(getCart);
    await turns();
    const gets = server.gets.length - before;
    await server.drain();
    m.dispose();
    return { gets, timeline: [...m.timeline] };
}

describe('a fold and the freshness window', () =>
{
    it('a landing that folds over a base past its window lets the next subscriber read it without a fetch', async () =>
    {
        const server = new GatedServer(0);
        const { clock, getCart } = await fetchedBase(server, 'landing-restarts-window');
        clock.now += 5 * FRESH;
        const run = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        (await server.postArrived(0)).release();
        expect((await run).ok).toBe(true);
        await turns();
        expect(await mountedGets(server, getCart)).toEqual({ gets: 0, timeline: [1] });
    });

    it('a drop that folds a confirmed guess it was holding back lets the next subscriber read it without a fetch', async () =>
    {
        const server = new GatedServer(0);
        const { clock, getCart } = await fetchedBase(server, 'drop-restarts-window');
        const mutation = adder(server, getCart, { invalidates: [] });
        const slow = mutation.run({ op: inc });
        const fast = mutation.run({ op: inc });
        const slowPost = await server.postArrived(0);
        (await server.postArrived(1)).release();
        expect((await fast).ok).toBe(true);
        clock.now += 5 * FRESH;
        slowPost.refuse();
        expect((await slow).ok).toBe(false);
        await turns();
        expect(await mountedGets(server, getCart)).toEqual({ gets: 0, timeline: [1] });
    });

    it('a landing whose fold stops at a guess that cannot read the value leaves the next subscriber fetching', async () =>
    {
        const server = new GatedServer(0);
        const { clock, getCart } = await fetchedBase(server, 'partial-landing-keeps-age');
        const slow = adder(server, getCart, { invalidates: [] }).run({ op: inc });
        const fast = adder(server, getCart, { invalidates: [] }).run({ op: fromEmpty });
        const slowPost = await server.postArrived(0);
        (await server.postArrived(1)).release();
        expect((await fast).ok).toBe(true);
        clock.now += 5 * FRESH;
        slowPost.release();
        await slow;
        await turns();
        const seen = await mountedGets(server, getCart);
        // GETs the mount started, what it showed, and the server's count.
        expect(`${ seen.gets } | ${ seen.timeline.join(',') } | ${ server.count }`).toBe('1 | 1,2 | 2');
    });

    it('a landing held back by a pending run leaves the next subscriber fetching', async () =>
    {
        const server = new GatedServer(0);
        const { clock, getCart } = await fetchedBase(server, 'held-landing-keeps-age');
        const mutation = adder(server, getCart, { invalidates: [] });
        const slow = mutation.run({ op: inc });
        const fast = mutation.run({ op: inc });
        const slowPost = await server.postArrived(0);
        clock.now += 5 * FRESH;
        (await server.postArrived(1)).release();
        expect((await fast).ok).toBe(true);
        await turns();
        expect(await mountedGets(server, getCart)).toEqual({ gets: 1, timeline: [2] });
        slowPost.release();
        expect((await slow).ok).toBe(true);
    });

    for (const empty of [true, false])
    {
        it(`a drop that folds nothing leaves the next subscriber fetching (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const { clock, getCart } = await fetchedBase(server, `empty-drop-keeps-age-${ String(empty) }`);
            clock.now += 5 * FRESH;
            const run = adder(server, getCart, empty ? { invalidates: [] } : {}).run({ op: inc });
            (await server.postArrived(0)).refuse();
            expect((await run).ok).toBe(false);
            await turns();
            expect(await mountedGets(server, getCart)).toEqual({ gets: 1, timeline: [0] });
        });
    }
});
