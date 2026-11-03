// @vitest-environment happy-dom
//
// A run refused or cancelled below a confirmed guess: the drop folds what it held back over a
// fetched base, keeps every fetch in flight, and never makes run() reject. No router in this file.
import { afterEach, describe, expect, it } from 'vitest';
import { cached, createMutation, createResource, createRoot, revalidate } from 'azerothjs';
import type { CachedFetcher, CachedOptions, Mutation, MutationResult, Resource } from 'azerothjs';
import type { Cart, CartFetcher, Op, Tracked } from '../support/gated-cart.ts';
import { GatedServer, adder, cartFamily, entryOf, inc, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    resetDataCache();
});

/** The error a run answered with, or undefined while it is pending or after it succeeded. */
function errorOf(result: Tracked<unknown>): unknown
{
    const answer = result.value() as MutationResult<number> | undefined;
    return answer === undefined || answer.ok ? undefined : answer.error;
}

/** Starts two runs, answers the second-called one first and waits for it to land. */
async function slowBelowFast(server: GatedServer, slowAdd: Mutation<Op, number>, fastAdd: Mutation<Op, number>, signal?: AbortSignal): Promise<{ slow: Promise<unknown>; refuse: () => void }>
{
    const slow = slowAdd.run({ op: inc }, signal === undefined ? {} : { signal });
    const fast = fastAdd.run({ op: inc });
    const slowPost = await server.postArrived(0);
    (await server.postArrived(1)).release();
    await fast;
    await turns();
    return { slow, refuse: slowPost.refuse };
}

describe('a confirmed guess held back by a run that then fails', () =>
{
    for (const empty of [false, true])
    {
        it(`keeps a refetch begun after the fast landing and starts no replacement (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `keeps-refetch-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const add = adder(server, getCart, empty ? { invalidates: [] } : {});
            const { slow, refuse } = await slowBelowFast(server, add, add);
            // Another client adds 5; the page then asks for fresh data, which carries both writes.
            server.count += 5;
            const before = server.gets.length;
            let atResolve: number | undefined;
            const refetched = track(m.cart.refetch().then(() =>
            {
                atResolve = m.cart.data()?.count;
            }));
            const fresh = await server.arrived(before);
            refuse();
            await slow;
            await turns();
            expect(fresh.aborted).toBe(false);
            await server.drain();
            await until(() => refetched.done(), 'the refetch');
            expect(server.gets).toHaveLength(before + 1);
            expect(atResolve).toBe(server.count);
            expect(m.cart.data()?.count).toBe(server.count);
            m.dispose();
        });
    }

    for (const how of ['cancel()', 'its signal'] as const)
    {
        it(`keeps the fast run's revalidation in flight when the slow run is cancelled by ${ how }`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `cancel-keeps-${ how }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const slowAdd = adder(server, getCart);
            const fastAdd = adder(server, getCart);
            const stop = new AbortController();
            const { slow } = await slowBelowFast(server, slowAdd, fastAdd, stop.signal);
            const revalidation = await server.arrived(1);
            if (how === 'cancel()')
            {
                slowAdd.cancel();
            }
            else
            {
                stop.abort();
            }
            await slow;
            await turns();
            expect(revalidation.aborted).toBe(false);
            await server.drain();
            expect(m.cart.data()?.count).toBe(server.count);
            m.dispose();
        });
    }

    it('keeps the fast run\'s revalidation in flight when the slow write is refused', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'refused-keeps');
        const m = mount(getCart);
        await server.releaseGet(0);
        const add = adder(server, getCart);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        const revalidation = await server.arrived(1);
        refuse();
        await slow;
        await turns();
        expect(revalidation.aborted).toBe(false);
        await server.drain();
        expect(m.cart.data()?.count).toBe(server.count);
        m.dispose();
    });

    it('lets the fast run\'s own revalidation, which carries every write, answer with no other fetch', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'own-revalidation');
        const m = mount(getCart);
        await server.releaseGet(0);
        const add = adder(server, getCart);
        const slow = add.run({ op: inc });
        const fast = add.run({ op: inc });
        const slowPost = await server.postArrived(0);
        const fastPost = await server.postArrived(1);
        // Another client adds 5 before the fast write commits.
        server.count += 5;
        fastPost.release();
        await fast;
        await turns();
        await server.arrived(1);
        slowPost.refuse();
        await slow;
        await turns();
        await server.drain();
        expect(m.cart.data()?.count).toBe(server.count);
        expect(server.gets).toHaveLength(2);
        m.dispose();
    });

    for (const empty of [true, false])
    {
        it(`with a fetch begun while the fast write was out never drops below the server value (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `begun-during-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const add = adder(server, getCart, empty ? { invalidates: [] } : {});
            const slow = add.run({ op: inc });
            const fast = add.run({ op: inc });
            const slowPost = await server.postArrived(0);
            const fastPost = await server.postArrived(1);
            void m.cart.refetch();
            const early = await server.arrived(1);
            fastPost.release();
            await fast;
            await turns();
            slowPost.refuse();
            await slow;
            await turns();
            const afterDrop = m.timeline.length;
            early.release();
            await turns();
            await server.drain();
            expect(m.cart.data()?.count).toBe(server.count);
            expect(Math.min(...m.timeline.slice(afterDrop - 1))).toBeGreaterThanOrEqual(server.count);
            m.dispose();
        });

        it(`with a fetch begun between two held-back landings never drops below the server value (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `between-landings-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const add = adder(server, getCart, empty ? { invalidates: [] } : {});
            const first = add.run({ op: inc });
            const second = add.run({ op: inc });
            const third = add.run({ op: inc });
            const firstPost = await server.postArrived(0);
            const secondPost = await server.postArrived(1);
            const thirdPost = await server.postArrived(2);
            secondPost.release();
            await second;
            await turns();
            if (empty)
            {
                void m.cart.refetch();
            }
            const between = await server.arrived(1);
            thirdPost.release();
            await third;
            await turns();
            firstPost.refuse();
            await first;
            await turns();
            const afterDrop = m.timeline.length;
            between.release();
            await turns();
            await server.drain();
            expect(m.cart.data()?.count).toBe(server.count);
            expect(Math.min(...m.timeline.slice(afterDrop - 1))).toBeGreaterThanOrEqual(server.count);
            m.dispose();
        });
    }

    it('with invalidates: [] a refetch begun before the fast landing is superseded there and the drop ends right', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'begun-before');
        const m = mount(getCart);
        await server.releaseGet(0);
        const add = adder(server, getCart, { invalidates: [] });
        const slow = add.run({ op: inc });
        const fast = add.run({ op: inc });
        const slowPost = await server.postArrived(0);
        const fastPost = await server.postArrived(1);
        let atResolve: number | undefined;
        const refetched = track(m.cart.refetch().then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        const early = await server.arrived(1);
        fastPost.release();
        await fast;
        await turns();
        expect(early.aborted).toBe(true);
        slowPost.refuse();
        await slow;
        await turns();
        await server.drain();
        await until(() => refetched.done(), 'the refetch');
        expect(atResolve).toBe(server.count);
        expect(m.cart.data()?.count).toBe(server.count);
        m.dispose();
    });

    for (const empty of [true, false])
    {
        it(`three runs, a refetch begun between the two fast landings, the slowest refused, end at the server value (invalidates ${ empty ? '[]' : 'default' })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `mixed-${ String(empty) }`);
            const m = mount(getCart);
            await server.releaseGet(0);
            const add = adder(server, getCart, empty ? { invalidates: [] } : {});
            const slowest = add.run({ op: inc });
            const fast1 = add.run({ op: inc });
            const fast2 = add.run({ op: inc });
            const slowestPost = await server.postArrived(0);
            const post1 = await server.postArrived(1);
            const post2 = await server.postArrived(2);
            post1.release();
            await fast1;
            await turns();
            const refetched = track(m.cart.refetch());
            post2.release();
            await fast2;
            await turns();
            slowestPost.refuse();
            await slowest;
            await turns();
            await server.drain();
            await until(() => refetched.done(), 'the refetch');
            expect(m.cart.data()?.count).toBe(server.count);
            m.dispose();
        });
    }

    it('over a never-fetched entry waits for the first fetch, so a later reader shows the server value', async () =>
    {
        const server = new GatedServer(5);
        const getCart = cartFamily(server, 'never-fetched', { fresh: Infinity });
        const add = adder(server, getCart, { invalidates: [], tolerant: true });
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        await slow;
        await turns();
        const m = mount(getCart);
        await server.drain();
        expect(m.cart.data()?.count).toBe(server.count);
        m.dispose();
    });
});

describe('run() answers a refused run as a failure whatever the drop finds', () =>
{
    it('over a never-fetched entry the refused run resolves ok: false with its error set', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'refused-never-fetched');
        const add = adder(server, getCart);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        expect(result.failure()).toBeUndefined();
        expect(result.value()).toMatchObject({ ok: false });
        expect(errorOf(result)).toHaveProperty('message', 'the server refused the write');
        expect(add.error()).toBe(errorOf(result));
    });

    it('a two-entry run refused over a never-fetched entry still drops its guess on the other entry', async () =>
    {
        const server = new GatedServer(0);
        const other = new GatedServer(10);
        const getCart = cartFamily(server, 'two-entry-cart');
        const getOther = cartFamily(other, 'two-entry-other');
        const m = mount(getOther);
        await other.releaseGet(0);
        const both = createMutation
        (
            (_input: Op, signal: AbortSignal) => server.post(inc, signal),
            {
                optimistic: (_input, patch) =>
                {
                    patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
                    patch(getOther, (cart: Cart) => ({ count: cart.count + 1 }));
                },
                invalidates: []
            }
        );
        const { slow, refuse } = await slowBelowFast(server, both, both);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        expect(result.failure()).toBeUndefined();
        expect(result.value()).toMatchObject({ ok: false });
        expect(errorOf(result)).toHaveProperty('message', 'the server refused the write');
        expect(both.error()).toBe(errorOf(result));
        expect(m.cart.data()?.count).toBe(11);
        expect(entryOf(getOther)?.layers).toHaveLength(0);
        m.dispose();
    });
});

type NullableCart = CachedFetcher<[], Cart | null>;

/** A fetched base of null under a guess that reads its count, as a fetcher whose type lies. */
async function nullBase(tag: string): Promise<NullableCart>
{
    const getCart = cached(`gated-null-${ tag }`, async (): Promise<Cart | null> => null);
    await getCart();
    return getCart;
}

/** A mutation whose write applies the run's op on the server and whose guess is `guess`. */
function guessWith(server: GatedServer, getCart: NullableCart, guess: (cart: Cart | null, input: Op) => Cart, invalidates: readonly CartFetcher[] = []): Mutation<Op, number>
{
    return createMutation
    (
        (input: Op, signal: AbortSignal) => server.post(input.op, signal),
        {
            optimistic: (input, patch) =>
            {
                patch(getCart, (cart: Cart | null) => guess(cart, input));
            },
            invalidates
        }
    );
}

function guessOver(server: GatedServer, getCart: NullableCart, tolerant: boolean, invalidates: readonly CartFetcher[] = []): Mutation<Op, number>
{
    return guessWith(server, getCart, (cart, input) => ({ count: input.op(tolerant ? cart?.count ?? 0 : (cart as Cart).count) }), invalidates);
}

/** Adds one below a count of 2 and throws from 2 on, as a guess over a shape it does not expect. */
function picky(cart: Cart | null): Cart
{
    const count = (cart as Cart).count;
    if (count >= 2)
    {
        throw new TypeError('this guess cannot read a cart of 2 or more');
    }
    return { count: count + 1 };
}

/** A guess typed honestly over a cart that may be missing, which refuses to guess without one. */
function strictAdd(cart: Cart | null): Cart
{
    if (cart === null)
    {
        throw new Error('no cart to add to yet');
    }
    return { count: cart.count + 1 };
}

/** A cart that does not exist until the first add: the server answers null while its count is 0. */
function missingUntilAdded(server: GatedServer, tag: string, options: CachedOptions = {}): NullableCart
{
    const read = async (signal: AbortSignal): Promise<Cart | null> =>
    {
        const cart = await server.get(signal);
        return cart.count === 0 ? null : cart;
    };
    return cached(`gated-missing-${ tag }`, read, options);
}

/** A resource over a cart that may be missing, in a root of its own. */
function readerOf(getCart: NullableCart): { cart: Resource<Cart | null>; dispose: () => void }
{
    let dispose!: () => void;
    const cart = createRoot((d) =>
    {
        dispose = d;
        return createResource(getCart);
    });
    return { cart, dispose };
}

const EVERY_RUN_LANDS = 'ok 1, ok 1, ok 1';

/**
 * Lands three runs that read a missing cart as empty, each revalidating a watched family, and
 * spells each run's answer with the refetches its revalidation started.
 */
async function threeLaterRuns(server: GatedServer, getCart: NullableCart): Promise<string>
{
    const other = new GatedServer(10);
    const getOther = cartFamily(other, 'later-watched');
    const watcher = mount(getOther);
    await other.releaseGet(0);
    const later = guessOver(server, getCart, true, [getOther]);
    const runs: string[] = [];
    for (let i = 0; i < 3; i++)
    {
        const gets = other.gets.length;
        const posts = server.posts.length;
        const run = track(later.run({ op: inc }));
        (await server.postArrived(posts)).release();
        await until(() => run.done(), 'a later run');
        await turns();
        runs.push(`${ run.value()?.ok === true ? 'ok' : 'failed' } ${ other.gets.length - gets }`);
        await other.drain();
    }
    watcher.dispose();
    return runs.join(', ');
}

describe('a drop over a fetched base the confirmed guess cannot read', () =>
{
    it('the refused run resolves ok: false with its refusal, and the guess that cannot read the base is dropped and its entry marked', async () =>
    {
        const server = new GatedServer(0);
        const getCart = await nullBase('refused');
        const add = guessOver(server, getCart, false);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        expect(result.failure()).toBeUndefined();
        expect(result.value()).toMatchObject({ ok: false });
        expect(errorOf(result)).toHaveProperty('message', 'the server refused the write');
        expect(add.error()).toBe(errorOf(result));
        expect(entryOf(getCart)?.layers).toHaveLength(0);
        expect(entryOf(getCart)?.stale).toBe(true);
    });

    it('over a fetched base it can read the confirmed guess folds into the value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cached('gated-readable-base', async (): Promise<Cart | null> => ({ count: 3 }));
        await getCart();
        const add = guessOver(server, getCart, false);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        expect(result.value()).toMatchObject({ ok: false });
        expect(entryOf(getCart)?.layers).toHaveLength(0);
        expect(await getCart()).toEqual({ count: 4 });
    });

    it('with nothing mounted marks the entry, so the next read answers the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = missingUntilAdded(server, 'drop-unmounted', { fresh: 60_000 });
        const first = track(getCart());
        await server.releaseGet(0);
        await until(() => first.done(), 'the first read');
        const add = guessWith(server, getCart, strictAdd);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        await slow;
        await turns();
        expect(entryOf(getCart)?.layers).toHaveLength(0);
        expect(entryOf(getCart)?.stale).toBe(true);
        const read = track(getCart());
        await server.drain();
        await until(() => read.done(), 'the read after the drop');
        expect(read.value()).toEqual({ count: server.count });
        expect(server.gets).toHaveLength(2);
    });

    it('with a reader mounted fetches at once, so the screen ends at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = missingUntilAdded(server, 'drop-mounted', { fresh: 60_000 });
        const first = track(getCart());
        await server.releaseGet(0);
        await until(() => first.done(), 'the first read');
        const reader = readerOf(getCart);
        await turns();
        const create = guessOver(server, getCart, true);
        const add = guessWith(server, getCart, strictAdd);
        const { slow, refuse } = await slowBelowFast(server, create, add);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        await server.drain();
        expect(result.value()).toMatchObject({ ok: false });
        expect(server.count).toBe(1);
        expect(reader.cart.data()).toEqual({ count: server.count });
        reader.dispose();
    });

    it('with a fetch begun after the landing in flight starts no fetch of its own', async () =>
    {
        const server = new GatedServer(0);
        const getCart = missingUntilAdded(server, 'drop-joins');
        const first = track(getCart());
        await server.releaseGet(0);
        await until(() => first.done(), 'the first read');
        const create = guessOver(server, getCart, true);
        const add = guessWith(server, getCart, strictAdd);
        const slow = create.run({ op: inc });
        const fast = add.run({ op: inc });
        const slowPost = await server.postArrived(0);
        const fastPost = await server.postArrived(1);
        // The mount refetches, and the landing replaces that fetch with one begun after it.
        const reader = readerOf(getCart);
        const refetch = await server.arrived(1);
        fastPost.release();
        await fast;
        await turns();
        expect(refetch.aborted).toBe(true);
        slowPost.refuse();
        await slow;
        await turns();
        await server.drain();
        expect(server.gets).toHaveLength(3);
        expect(reader.cart.data()).toEqual({ count: server.count });
        reader.dispose();
    });

    it('with a revalidate waiting on a fetch in flight keeps its follow-up, so the revalidate resolves at the server value', async () =>
    {
        const server = new GatedServer(0);
        const getCart = missingUntilAdded(server, 'drop-revalidate', { fresh: 60_000 });
        const first = track(getCart());
        await server.releaseGet(0);
        await until(() => first.done(), 'the first read');
        const reader = readerOf(getCart);
        await turns();
        const create = guessOver(server, getCart, true);
        const add = guessWith(server, getCart, strictAdd);
        const { slow, refuse } = await slowBelowFast(server, create, add);
        // A refetch begun after the landing, and a revalidate called while it is out.
        void reader.cart.refetch();
        const during = await server.arrived(1);
        let atResolve: Cart | null | undefined;
        const revalidated = track(revalidate(getCart).then(() =>
        {
            atResolve = reader.cart.data();
        }));
        refuse();
        await slow;
        await turns();
        during.release();
        await server.drain();
        expect(server.gets).toHaveLength(3);
        await until(() => revalidated.done(), 'the revalidate');
        expect(atResolve).toEqual({ count: server.count });
        reader.dispose();
    });

    it('another mutation\'s refused run, whose own guess reads null safely, resolves with its own error', async () =>
    {
        const server = new GatedServer(0);
        const getCart = await nullBase('blame');
        const safe = guessOver(server, getCart, true);
        const unsafe = guessOver(server, getCart, false);
        const { slow, refuse } = await slowBelowFast(server, safe, unsafe);
        refuse();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        expect(result.failure()).toBeUndefined();
        expect(result.value()).toMatchObject({ ok: false });
        expect(errorOf(result)).toHaveProperty('message', 'the server refused the write');
        expect(safe.error()).toBe(errorOf(result));
    });

    it('a cancelled run resolves as cancelled and its own invalidation still runs', async () =>
    {
        const server = new GatedServer(0);
        const other = new GatedServer(10);
        const getOther = cartFamily(other, 'cancel-other');
        const watcher = mount(getOther);
        await other.releaseGet(0);
        const getCart = await nullBase('cancelled');
        const slowAdd = guessOver(server, getCart, false, [getOther]);
        const fastAdd = guessOver(server, getCart, false);
        const stop = new AbortController();
        const { slow } = await slowBelowFast(server, slowAdd, fastAdd, stop.signal);
        const otherGets = other.gets.length;
        stop.abort();
        const result = track(slow);
        await until(() => result.done(), 'the slow run');
        await turns();
        expect(result.failure()).toBeUndefined();
        expect(result.value()).toMatchObject({ ok: false, cancelled: true });
        expect(slowAdd.error()).toBeNull();
        expect(errorOf(result)).toHaveProperty('name', 'AbortError');
        expect(other.gets.length).toBe(otherGets + 1);
        await other.drain();
        watcher.dispose();
    });
});

describe('later runs after a confirmed guess that could not read its base', () =>
{
    it('after a drop that reaches a held-back guess unable to read the folded count, every later run lands and revalidates', async () =>
    {
        const server = new GatedServer(1);
        const getCart = cached('gated-later-drop-count', (signal: AbortSignal): Promise<Cart | null> => server.get(signal));
        const first = getCart();
        await server.releaseGet(0);
        await first;
        const slowAdd = guessOver(server, getCart, false);
        const fastAdd = guessOver(server, getCart, false);
        const pickyAdd = guessWith(server, getCart, picky);
        const slow = slowAdd.run({ op: inc });
        const fast = fastAdd.run({ op: inc });
        const held = pickyAdd.run({ op: inc });
        const slowPost = await server.postArrived(0);
        (await server.postArrived(1)).release();
        await fast;
        (await server.postArrived(2)).release();
        await held;
        await turns();
        slowPost.refuse();
        await slow;
        await turns();
        expect(await threeLaterRuns(server, getCart)).toBe(EVERY_RUN_LANDS);
    });

    it('after a drop over a fetched null the held-back guess cannot read, every later run lands and revalidates', async () =>
    {
        const server = new GatedServer(0);
        const getCart = await nullBase('later-null');
        const add = guessOver(server, getCart, false);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        await slow;
        await turns();
        expect(await threeLaterRuns(server, getCart)).toBe(EVERY_RUN_LANDS);
    });

    it('after a drop under a guess that refuses a missing cart by design, every later run lands and revalidates', async () =>
    {
        const server = new GatedServer(0);
        const getCart = await nullBase('later-strict');
        const add = guessWith(server, getCart, strictAdd);
        const { slow, refuse } = await slowBelowFast(server, add, add);
        refuse();
        await slow;
        await turns();
        expect(await threeLaterRuns(server, getCart)).toBe(EVERY_RUN_LANDS);
    });

    it('after a landing whose fold reaches a held-back guess unable to read it, every later run lands and revalidates', async () =>
    {
        const server = new GatedServer(1);
        const getCart = cached('gated-later-settle-count', (signal: AbortSignal): Promise<Cart | null> => server.get(signal));
        const first = getCart();
        await server.releaseGet(0);
        await first;
        const slowAdd = guessOver(server, getCart, false);
        const pickyAdd = guessWith(server, getCart, picky);
        const slow = track(slowAdd.run({ op: inc }));
        const held = pickyAdd.run({ op: inc });
        const slowPost = await server.postArrived(0);
        (await server.postArrived(1)).release();
        await held;
        await turns();
        slowPost.release();
        await until(() => slow.done(), 'the slow run');
        await turns();
        expect(slow.failure()).toBeUndefined();
        expect(await threeLaterRuns(server, getCart)).toBe(EVERY_RUN_LANDS);
    });
});
