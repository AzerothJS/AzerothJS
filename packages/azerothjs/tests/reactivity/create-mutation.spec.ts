// @vitest-environment happy-dom
//
// Mutations, driven at the gaps a hand-rolled optimistic update actually has. Measured before
// this existed, with the override-signal shape an application is otherwise left with:
//
//   - two readers of ONE cached family SPLIT during the optimistic window (page 1, header 0),
//     because a guess held beside one resource cannot leave that resource's scope;
//   - the value DOUBLE COUNTS between the refetch landing and the override being released;
//   - N mutations cost N+1 refetches.
//
// Every test below carries a control, because the first version of that measurement was wrong:
// it wrapped the cached fetcher in an arrow, which loses the brand and drops the resource to
// the unshared path, so `revalidate` updated nothing and every result was meaningless.
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { cached, createMutation, createResource, createRoot, revalidate } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Cart { count: number }

/** A server whose cart only the writes below can move. */
function server(): { cart: Cart; loads: number }
{
    return { cart: { count: 0 }, loads: 0 };
}

describe('createMutation: the optimistic guess is shared', () =>
{
    it('moves EVERY reader of the family, not just the one that ran it', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-shared', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async () =>
        {
            await wait(30);
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            // Two components reading one family, as a header badge and a cart page would.
            const header = createResource(getCart);
            const page = createResource(getCart);
            await wait(40);
            // The control: they share the entry, so they agree BEFORE anything optimistic.
            expect(header.data()?.count).toBe(0);
            expect(page.data()?.count).toBe(0);

            const running = add.run(undefined);
            await flush();
            // The gap this exists to close: both move, immediately.
            expect(header.data()?.count).toBe(1);
            expect(page.data()?.count).toBe(1);
            expect(add.pending()).toBe(true);

            await running;
            await wait(40);
            expect(header.data()?.count).toBe(1);
            expect(page.data()?.count).toBe(1);
            expect(state.cart.count).toBe(1);
            expect(add.pending()).toBe(false);
            dispose();
        });
    });

    it('never double counts: the promotion and the guess removal are one update', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-nodouble', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async () =>
        {
            await wait(20);
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            // Every value any reader observes, from the click until well after the refetch.
            const seen: number[] = [];
            const record = (): void =>
            {
                const count = cart.data()?.count;
                if (count !== undefined && seen[seen.length - 1] !== count)
                {
                    seen.push(count);
                }
            };
            record();
            const running = add.run(undefined);
            for (let tick = 0; tick < 40; tick++)
            {
                record();
                await wait(3);
            }
            await running;
            for (let tick = 0; tick < 20; tick++)
            {
                record();
                await wait(3);
            }

            // 0 then 1. A 2 anywhere is the double count the hand-rolled shape produces.
            expect(seen).toEqual([0, 1]);
            expect(state.cart.count).toBe(1);
            dispose();
        });
    });
});

describe('createMutation: failure and concurrency', () =>
{
    it('a failure removes exactly its own guess and records the error', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-fail', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async (ok: boolean) =>
        {
            await wait(20);
            if (!ok)
            {
                throw new Error('out of stock');
            }
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_ok, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const result = await add.run(false);
            // `run` NEVER rejects for a failed write - a fire-and-forget onClick must stay safe.
            expect(result.ok).toBe(false);
            expect(String(result.ok ? '' : result.error)).toContain('out of stock');
            expect(String(add.error())).toContain('out of stock');
            await wait(40);
            expect(cart.data()?.count).toBe(0);
            expect(state.cart.count).toBe(0);

            // The control: the same mutation succeeding still lands, so the rollback did not
            // leave the entry poisoned.
            const good = await add.run(true);
            expect(good.ok).toBe(true);
            await wait(40);
            expect(cart.data()?.count).toBe(1);
            expect(add.error()).toBeNull();
            dispose();
        });
    });

    it('two runs in flight are two layers: one failing leaves the other standing', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-concurrent', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async (input: { ok: boolean; ms: number }) =>
        {
            await wait(input.ms);
            if (!input.ok)
            {
                throw new Error('refused');
            }
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const slowGood = add.run({ ok: true, ms: 60 });
            const fastBad = add.run({ ok: false, ms: 15 });
            await flush();
            // Both guesses stack.
            expect(cart.data()?.count).toBe(2);

            await fastBad;
            await flush();
            // The failure removed ITS OWN layer and left the other's alone.
            expect(cart.data()?.count).toBe(1);
            expect(add.pending()).toBe(true);

            await slowGood;
            await wait(60);
            expect(cart.data()?.count).toBe(1);
            expect(state.cart.count).toBe(1);
            expect(add.pending()).toBe(false);
            dispose();
        });
    });

    it('an out-of-order success waits for the guess below it before folding', async () =>
    {
        resetDataCache();
        const state = server();
        state.cart = { count: 1 };
        const getCart = cached('cart-order', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        // NON-COMMUTATIVE on purpose. Two `+1` guesses cannot tell the orders apart - the first
        // version of this test used them and passed under a deliberately out-of-order fold, so
        // it was proving nothing. Doubling and then adding is 12; adding and then doubling is 22.
        const apply = createMutation(async (input: { ms: number; kind: 'double' | 'add' }) =>
        {
            await wait(input.ms);
            state.cart = input.kind === 'double'
                ? { count: state.cart.count * 2 }
                : { count: state.cart.count + 10 };
        }, {
            optimistic: (input, patch) =>
            {
                patch(getCart, (cart: Cart) => (input.kind === 'double'
                    ? { count: cart.count * 2 }
                    : { count: cart.count + 10 }));
            },
            // Nothing to revalidate: this test is about the fold order alone.
            invalidates: []
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);
            expect(cart.data()?.count).toBe(1);

            // The SECOND run settles first. Folding it immediately would apply it to the base
            // and leave the first guess on top, which projects (1 + 10) * 2 = 22.
            const doubling = apply.run({ ms: 60, kind: 'double' });
            const adding = apply.run({ ms: 15, kind: 'add' });
            await adding;
            await flush();
            expect(cart.data()?.count).toBe(12);

            await doubling;
            await flush();
            expect(cart.data()?.count).toBe(12);

            // And the contract this exposes, pinned rather than hidden: guesses stack in CALL
            // order while the server applies writes in COMPLETION order, so for operations that
            // do not commute the two genuinely disagree - here the server ran add-then-double
            // and holds 22. Only a revalidate reconciles them, which is why `invalidates`
            // defaults to what was patched instead of being opt-in.
            expect(state.cart.count).toBe(22);
            await revalidate(getCart);
            expect(cart.data()?.count).toBe(22);
            dispose();
        });
    });
});

describe('createMutation: invalidation', () =>
{
    it('revalidates what it patched, without being told to', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-invalidate', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        // The server moves the count by TWO while the guess says one, so only a real refetch
        // can produce the right number - a passing assertion cannot come from the guess.
        const add = createMutation(async () =>
        {
            await wait(20);
            state.cart = { count: state.cart.count + 2 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);
            const loadsBefore = state.loads;

            await add.run(undefined);
            await wait(60);

            expect(state.loads).toBeGreaterThan(loadsBefore);
            expect(cart.data()?.count).toBe(2);
            dispose();
        });
    });

    it('invalidates: [] revalidates nothing, so the promoted guess stands alone', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cart-noinvalidate', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async () =>
        {
            await wait(20);
            state.cart = { count: state.cart.count + 2 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            },
            invalidates: []
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);
            const loadsBefore = state.loads;

            await add.run(undefined);
            await wait(60);

            expect(state.loads).toBe(loadsBefore);
            // The guess, promoted and uncorrected - which is what asking for no refetch means.
            expect(cart.data()?.count).toBe(1);
            expect(state.cart.count).toBe(2);

            // The control: an explicit revalidate still reaches it, so the entry is live.
            await revalidate(getCart);
            expect(cart.data()?.count).toBe(2);
            dispose();
        });
    });

    it('refuses a patch aimed at anything but a cached fetcher', async () =>
    {
        const plain = async (): Promise<number> => 1;
        const add = createMutation(async () => undefined, {
            optimistic: (_input, patch) =>
            {
                (patch as unknown as (target: unknown, next: unknown) => void)(plain, (value: number) => value);
            }
        });
        // A guess on an unshared function is a guess nothing can read. Refused LOUDLY rather
        // than answered as { ok: false }: it is a bug in the mutation, not a refusal by the
        // server, and reporting it as an ordinary failure would hide it behind a retry button.
        await expect(add.run(undefined)).rejects.toThrow(/cached\(\.\.\.\) fetcher/);
    });

    it('a mutation with no optimistic block is still a mutation', async () =>
    {
        resetDataCache();
        const state = server();
        const write = vi.fn(async () =>
        {
            await wait(10);
            state.cart = { count: 7 };
            return 'receipt';
        });
        const plain = createMutation(write);

        await createRoot(async (dispose) =>
        {
            expect(plain.pending()).toBe(false);
            const running = plain.run(undefined);
            await flush();
            expect(plain.pending()).toBe(true);
            const result = await running;
            expect(result).toEqual({ ok: true, data: 'receipt' });
            expect(plain.pending()).toBe(false);
            expect(state.cart.count).toBe(7);
            dispose();
        });
    });
});

describe('createMutation: cancellation', () =>
{
    /** A cart whose write is slow enough to be cancelled mid-flight, and honours its signal. */
    function slowCart(name: string, ms = 60)
    {
        const state = server();
        const getCart = cached(name, async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const seenSignals: AbortSignal[] = [];
        const add = createMutation(async (_input: undefined, signal: AbortSignal) =>
        {
            seenSignals.push(signal);
            await new Promise<void>((resolve, reject) =>
            {
                const timer = setTimeout(resolve, ms);
                signal.addEventListener('abort', () =>
                {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                }, { once: true });
            });
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });
        return { state, getCart, add, seenSignals };
    }

    it('withdraws the guess, aborts the request, and does not report a failure', async () =>
    {
        resetDataCache();
        const { state, getCart, add, seenSignals } = slowCart('cancel-basic');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const running = add.run(undefined);
            await flush();
            expect(cart.data()?.count).toBe(1);
            expect(add.pending()).toBe(true);

            add.cancel();
            const outcome = await running;

            expect(outcome).toMatchObject({ ok: false, cancelled: true });
            // The write's own signal aborted, so the request stops rather than running on.
            expect(seenSignals[0]?.aborted).toBe(true);
            expect(add.pending()).toBe(false);
            // A cancel is the user's own doing: nothing to show them.
            expect(add.error()).toBeNull();

            await wait(60);
            // The guess is withdrawn and the server never moved.
            expect(cart.data()?.count).toBe(0);
            expect(state.cart.count).toBe(0);
            dispose();
        });
    });

    it('still revalidates, because aborting cannot un-do a write already committed', async () =>
    {
        resetDataCache();
        const state = server();
        const getCart = cached('cancel-revalidate', async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        // Ignores its signal and commits anyway - the case a cancel cannot actually prevent.
        const add = createMutation(async () =>
        {
            await wait(30);
            state.cart = { count: state.cart.count + 5 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            }
        });

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);
            const loadsBefore = state.loads;

            const running = add.run(undefined);
            await flush();
            add.cancel();
            expect(await running).toMatchObject({ ok: false, cancelled: true });

            await wait(80);
            // Refetched, so the screen shows what the server really did rather than the
            // pre-cancel number it no longer has any claim to.
            expect(state.loads).toBeGreaterThan(loadsBefore);
            expect(cart.data()?.count).toBe(5);
            dispose();
        });
    });

    it('cancels only what it is asked to: one run, or all of them', async () =>
    {
        resetDataCache();
        const { getCart, add, state } = slowCart('cancel-scoped', 80);

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const first = new AbortController();
            const cancelled = add.run(undefined, { signal: first.signal });
            const survivor = add.run(undefined);
            await flush();
            expect(cart.data()?.count).toBe(2);

            first.abort();
            expect(await cancelled).toMatchObject({ ok: false, cancelled: true });
            await flush();
            // Exactly one guess withdrawn; the other run is untouched and still in flight.
            expect(cart.data()?.count).toBe(1);
            expect(add.pending()).toBe(true);

            expect(await survivor).toMatchObject({ ok: true });
            await wait(80);
            expect(state.cart.count).toBe(1);
            expect(add.pending()).toBe(false);
            dispose();
        });
    });

    it('a signal already aborted never reaches the server', async () =>
    {
        resetDataCache();
        const write = vi.fn(async () => undefined);
        const add = createMutation(write);
        const aborted = AbortSignal.abort();

        await createRoot(async (dispose) =>
        {
            const outcome = await add.run(undefined, { signal: aborted });
            expect(outcome).toMatchObject({ ok: false, cancelled: true });
            // Not merely handed a dead signal: never called. A round trip nobody is waiting for
            // is one the server should not be asked to make.
            expect(write).not.toHaveBeenCalled();
            expect(add.pending()).toBe(false);
            dispose();
        });
    });

    it('CONTROL: an uncancelled run is unaffected by cancellation existing', async () =>
    {
        resetDataCache();
        const { getCart, add, state } = slowCart('cancel-control', 20);

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);
            expect(await add.run(undefined)).toMatchObject({ ok: true });
            await wait(60);
            expect(cart.data()?.count).toBe(1);
            expect(state.cart.count).toBe(1);
            expect(add.error()).toBeNull();
            dispose();
        });
    });
});

describe('createMutation: concurrency policies', () =>
{
    /**
     * A counter whose write records the ORDER the server saw, and whose duration is per call -
     * so a test can make the second run finish first and see which policy notices.
     */
    function ordered(name: string, policy?: 'parallel' | 'drop' | 'restart' | 'queue')
    {
        const state = server();
        const served: string[] = [];
        const getCart = cached(name, async (): Promise<Cart> =>
        {
            state.loads += 1;
            await wait(10);
            return { count: state.cart.count };
        });
        const add = createMutation(async (input: { tag: string; ms: number }, signal: AbortSignal) =>
        {
            await new Promise<void>((resolve, reject) =>
            {
                const timer = setTimeout(resolve, input.ms);
                signal.addEventListener('abort', () =>
                {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                }, { once: true });
            });
            served.push(input.tag);
            state.cart = { count: state.cart.count + 1 };
        }, {
            optimistic: (_input, patch) =>
            {
                patch(getCart, (cart: Cart) => ({ count: cart.count + 1 }));
            },
            ...(policy !== undefined ? { policy } : {})
        });
        return { state, getCart, add, served };
    }

    it('parallel (the default) lets both through and stacks their guesses', async () =>
    {
        resetDataCache();
        const { state, getCart, add, served } = ordered('policy-parallel');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const slow = add.run({ tag: 'first', ms: 60 });
            const fast = add.run({ tag: 'second', ms: 15 });
            await flush();
            expect(cart.data()?.count).toBe(2);

            expect(await fast).toMatchObject({ ok: true });
            expect(await slow).toMatchObject({ ok: true });
            await wait(60);
            expect(state.cart.count).toBe(2);
            // Both reached the server, in whatever order they finished.
            expect([...served].sort()).toEqual(['first', 'second']);
            dispose();
        });
    });

    it('drop refuses the second outright: no guess, no request', async () =>
    {
        resetDataCache();
        const { state, getCart, add, served } = ordered('policy-drop', 'drop');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const first = add.run({ tag: 'first', ms: 40 });
            await flush();
            expect(cart.data()?.count).toBe(1);

            const second = await add.run({ tag: 'second', ms: 40 });
            expect(second).toMatchObject({ ok: false, cancelled: true });
            // The refused run left NO trace: a guess applied and withdrawn would flicker.
            expect(cart.data()?.count).toBe(1);

            expect(await first).toMatchObject({ ok: true });
            await wait(60);
            expect(served).toEqual(['first']);
            expect(state.cart.count).toBe(1);
            // And a run after the first settles is accepted again.
            expect(await add.run({ tag: 'third', ms: 5 })).toMatchObject({ ok: true });
            dispose();
        });
    });

    it('restart cancels what is in flight and lets the newcomer through', async () =>
    {
        resetDataCache();
        const { state, getCart, add, served } = ordered('policy-restart', 'restart');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const superseded = add.run({ tag: 'first', ms: 60 });
            await flush();
            expect(cart.data()?.count).toBe(1);

            const winner = add.run({ tag: 'second', ms: 20 });
            expect(await superseded).toMatchObject({ ok: false, cancelled: true });
            await flush();
            // The superseded guess is gone and only the newcomer's remains.
            expect(cart.data()?.count).toBe(1);

            expect(await winner).toMatchObject({ ok: true });
            await wait(80);
            // Only the last input reached the server.
            expect(served).toEqual(['second']);
            expect(state.cart.count).toBe(1);
            dispose();
        });
    });

    it('queue serves them in CALL order however the network reorders them', async () =>
    {
        resetDataCache();
        const { state, getCart, add, served } = ordered('policy-queue', 'queue');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            // The second would finish far sooner if both ran at once - under parallel the
            // server sees 'second' first, which is exactly what this policy exists to prevent.
            const first = add.run({ tag: 'first', ms: 50 });
            const second = add.run({ tag: 'second', ms: 5 });
            await flush();
            // Both guesses are on screen at once; only the writes are serialized.
            expect(cart.data()?.count).toBe(2);

            expect(await first).toMatchObject({ ok: true });
            expect(await second).toMatchObject({ ok: true });
            expect(served).toEqual(['first', 'second']);
            await wait(60);
            expect(state.cart.count).toBe(2);
            dispose();
        });
    });

    it('a queued run cancelled before its turn never reaches the server', async () =>
    {
        resetDataCache();
        const { state, getCart, add, served } = ordered('policy-queue-cancel', 'queue');

        await createRoot(async (dispose) =>
        {
            const cart = createResource(getCart);
            await wait(40);

            const first = add.run({ tag: 'first', ms: 50 });
            const waiting = new AbortController();
            const second = add.run({ tag: 'second', ms: 5 }, { signal: waiting.signal });
            await flush();
            expect(cart.data()?.count).toBe(2);

            waiting.abort();
            expect(await second).toMatchObject({ ok: false, cancelled: true });
            expect(await first).toMatchObject({ ok: true });
            await wait(80);

            expect(served).toEqual(['first']);
            expect(state.cart.count).toBe(1);
            dispose();
        });
    });
});

describe('a parameterised cached fetcher is a valid mutation target', () =>
{
    interface User { id: number; name: string }
    const getUser = cached('typed-user', async (id: number): Promise<User> => ({ id, name: 'u' }));
    const getAll = cached('typed-all', async (): Promise<User[]> => []);

    it('type-checks with revalidate, patch and invalidates, keyed by its own argument list', () =>
    {
        // Real call sites, so the generic infers the family's own argument list: a
        // callable-with matcher instantiates it at the constraint and proves nothing.
        const typed = (): void =>
        {
            void revalidate(getUser, [1]);
            void revalidate(getUser);
            void revalidate(getAll);
            // @ts-expect-error the arguments must match the fetcher's own list
            void revalidate(getUser, ['1']);
        };
        expect(typeof typed).toBe('function');
        const mutation = createMutation(async (_input: number) => undefined, {
            invalidates: [getUser, getAll],
            optimistic: (input, patch) =>
            {
                patch(getUser, [input], (user) =>
                {
                    expectTypeOf(user).toEqualTypeOf<User>();
                    return { ...user, name: 'guess' };
                });
                patch(getAll, (all) =>
                {
                    expectTypeOf(all).toEqualTypeOf<User[]>();
                    return all;
                });
                // @ts-expect-error a keyed family needs its arguments
                patch(getUser, (user: User) => user);
            }
        });
        expect(typeof mutation.run).toBe('function');
    });

    it('revalidates one keyed entry at runtime through the same signature', async () =>
    {
        resetDataCache();
        let fetches = 0;
        const getItem = cached('typed-item', async (id: number): Promise<{ id: number; n: number }> => ({ id, n: ++fetches }));
        await createRoot(async (dispose) =>
        {
            // The branded fetcher itself subscribes, keyed by its source; an arrow would drop the brand.
            const item = createResource(() => 7, getItem);
            await vi.waitFor(() => expect(item.data()?.n).toBe(1));
            await revalidate(getItem, [7]);
            await vi.waitFor(() => expect(item.data()?.n).toBe(2));
            dispose();
        });
    });
});
