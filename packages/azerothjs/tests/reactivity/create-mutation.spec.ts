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
import { describe, expect, it, vi } from 'vitest';
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
