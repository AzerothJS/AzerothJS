/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Mutations: the write half of the data layer.
 *
 * A mutation is the thing a form (or a button, or a keypress) submits to. It owns the four
 * things every application otherwise rebuilds around a bare `await api.cart.add(item)`:
 *
 *   - the OPTIMISTIC guess, written into the CACHE rather than beside one resource, so every
 *     reader of the data moves together. A guess held in a component's own signal moves only
 *     that component: a cart badge in the header stays on the old number for the whole round
 *     trip while the cart page already shows the new one.
 *   - ROLLBACK, by removing exactly this run's guess. Concurrent runs are separate layers, so
 *     one failing never disturbs another's.
 *   - INVALIDATION of what the write changed, defaulting to whatever the guess patched, which
 *     is what an author means in every ordinary case and the thing whose omission silently
 *     leaves the screen stale.
 *   - PENDING and ERROR state, per mutation rather than per component.
 *
 * On success the guess is PROMOTED: it becomes the entry's value the moment the server accepts
 * it, and the revalidation runs behind. The alternative - holding it until the refetch lands -
 * reverts a change the server already took whenever that refetch is slow or fails, which is
 * worse than briefly showing a confirmed guess as truth.
 *
 * `run` never rejects for a WRITE failure. It answers `{ ok: true, data }` or `{ ok: false,
 * error }`, the shape this codebase already uses for a fallible call that a caller may
 * reasonably ignore - an `onClick` that fires and forgets must not become an unhandled
 * rejection. MISUSE is the exception and stays loud: a patch aimed at something other than a
 * `cached` fetcher rejects, because that is a bug in the mutation rather than a refusal by the
 * server, and silently reporting it as an ordinary failure would hide it behind a retry button.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { batch } from './batch.ts';
import { untrack } from './untrack.ts';
import { assertFunction } from './validate.ts';
import { DEV } from './dev.ts';
import { isStringMode } from './render-mode.ts';
import type { CacheEntry, CachedFetcher } from './data-cache.ts';
import { cachedFamilyOf, getDataCache, revalidate } from './data-cache.ts';

/** Any `cached` fetcher, whatever its argument list. */
type AnyCached = CachedFetcher<never[], unknown>;

/**
 * Records one optimistic guess against a `cached` family.
 *
 * `patch(getCart, next)` targets the argument-less entry; `patch(getUser, ['42'], next)` targets
 * one keyed entry. `next` receives the value a reader would see right now - the entry's value
 * with any earlier in-flight guess already applied - and returns the guessed one. It must be
 * PURE and must not mutate its argument: it re-runs on every read, and on every other run's
 * failure, so a projection with a side effect fires an unpredictable number of times.
 */
export interface PatchFn
{
    <T>(target: CachedFetcher<never[], T>, next: (value: T) => T): void;
    <T>(target: CachedFetcher<never[], T>, args: readonly unknown[], next: (value: T) => T): void;
}

/**
 * What a mutation does when a run starts while another is still in flight.
 *
 *   - `parallel` (default) - both proceed. Guesses stack, and each run settles on its own, so
 *     two adds show two and each rolls back only its own. Right whenever the writes commute.
 *   - `drop` - the new run is refused before anything happens: no guess, no request. The
 *     double-submit guard, and what a submit button wants.
 *   - `restart` - the runs in flight are CANCELLED and the new one takes over. What a
 *     search-as-you-type or an autosave wants, where only the last input matters.
 *   - `queue` - the guess applies at once, and the writes run one at a time in CALL order.
 *     For writes that do not commute, where the server must see them in the order they were
 *     made.
 *
 * Every policy is deterministic under overlap: the ordering is decided by when `run` was
 * called, never by which request happened to answer first.
 */
export type MutationPolicy = 'parallel' | 'drop' | 'restart' | 'queue';

/** What {@link createMutation} accepts beside the function that performs the write. */
export interface MutationOptions<In>
{
    /**
     * Declares what this mutation EXPECTS to happen, before the server has said so. Every
     * reader of a patched family shows the guess immediately; a failure removes it.
     *
     * Called once per run, with that run's input. A run that patches nothing is still a
     * mutation - it just has no optimistic phase.
     */
    optimistic?: (input: In, patch: PatchFn) => void;

    /**
     * The families to revalidate once the server accepts the write. Defaults to whatever
     * `optimistic` patched, which is what an author means in the ordinary case; declare it
     * explicitly to invalidate data this mutation changed but did not guess at - adding a
     * cart item that also changes a recommendations list, say.
     *
     * An empty array means "revalidate nothing", which is the right answer when the mutation's
     * own response already carries everything that changed.
     */
    invalidates?: readonly AnyCached[];

    /**
     * What happens when a run starts while another is in flight. Defaults to `parallel`, which
     * is what this did before the option existed. See {@link MutationPolicy}.
     */
    policy?: MutationPolicy;
}

/** One run's outcome. Never a rejection: a fire-and-forget call site must stay safe. */
export type MutationResult<Out> =
    | { ok: true; data: Out }
    /**
     * `cancelled` marks a run that DID NOT HAPPEN rather than one that failed - abandoned in
     * flight, or refused before it started under the `drop` policy. Either way there is
     * nothing to report to anyone, which is why `error()` stays untouched for both.
     */
    | { ok: false; error: unknown; cancelled?: true };

/** The object {@link createMutation} returns. */
export interface Mutation<In, Out>
{
    /** Reactive: true while ANY run of this mutation is in flight. */
    pending: Getter<boolean>;

    /** Reactive: the most recent failure, or null. Cleared when a run starts. */
    error: Getter<unknown>;

    /**
     * Performs the write. Applies the optimistic guess, calls the function, then either
     * promotes the guess and revalidates behind it, or removes the guess and records the error.
     *
     * `options.signal` cancels THIS run; see {@link Mutation.cancel} for what that means.
     *
     * Rejects only on MISUSE (see the module docblock); a write that fails answers
     * `{ ok: false, error }`.
     */
    run: (input: In, options?: { signal?: AbortSignal }) => Promise<MutationResult<Out>>;

    /**
     * Abandons every run of this mutation that is still in flight.
     *
     * Precisely, per cancelled run: the request's signal aborts, its optimistic guess is
     * DROPPED, `pending()` falls as it leaves flight, `error()` is left ALONE - a cancel is
     * not a failure to show anyone - and `run` answers `{ ok: false, cancelled: true }`.
     * Other runs in flight keep their own guesses, because a guess belongs to one run.
     *
     * The invalidation still runs. Aborting a request cannot un-do a write a server may
     * already have committed, so the only honest thing left is to go and look: dropping the
     * guess without refetching would leave the screen asserting a past it no longer knows.
     *
     * Disposing the surrounding scope does NOT cancel. A click that starts a write should
     * finish even if the component that started it goes away, and silently abandoning writes
     * on unmount is how a cart quietly loses an item.
     */
    cancel: () => void;
}

/** @internal One run's guess against one entry, remembered so it can be settled or dropped. */
interface AppliedLayer
{
    entry: CacheEntry;
    id: number;
}

/** @internal One patched entry, as `revalidate` addresses it. */
interface PatchTarget
{
    fetcher: AnyCached;

    /** The entry's own arguments; empty for an argument-less family. */
    args: readonly unknown[];
}

/**
 * Builds a {@link Mutation} over `write` - typically a typed API client call.
 *
 * @param write - Performs the write; receives the run's input.
 * @param options - See {@link MutationOptions}.
 * @returns The mutation's reactive state plus `run`.
 * @throws {TypeError} If `write` is not a function, or a patch targets something other than a
 *                     `cached` fetcher - a patch keyed on an unshared function would be a guess
 *                     nothing could ever read.
 * @example
 * const addToCart = createMutation((item: CartItem) => api.cart.add(item), {
 *     optimistic: (item, patch) =>
 *     {
 *         patch(getCart, (cart) => ({ ...cart, count: cart.count + item.qty }));
 *     }
 * });
 *
 * <button disabled={ addToCart.pending() } onClick={ () => addToCart.run(item) }>Add</button>
 */
export function createMutation<In, Out>(
    write: (input: In, signal: AbortSignal) => Promise<Out>,
    options: MutationOptions<In> = {}
): Mutation<In, Out>
{
    assertFunction(write, 'createMutation', 'the write function');

    const [inFlight, setInFlight] = createSignal(0, { name: 'mutation-in-flight' });
    const [error, setError] = createSignal<unknown>(null, { name: 'mutation-error' });

    /** Every run still in flight, so `cancel` can reach all of them and only them. */
    const running = new Set<AbortController>();

    const policy = options.policy ?? 'parallel';

    /**
     * The tail of the `queue` policy's chain. Each run waits on the one called before it, so
     * the server sees them in call order however the network reorders their round trips.
     */
    let queued: Promise<unknown> = Promise.resolve();

    /** Applies this run's guesses and reports which entries they touched. */
    function applyGuess(input: In): { layers: AppliedLayer[]; touched: PatchTarget[] }
    {
        const layers: AppliedLayer[] = [];
        const touched: PatchTarget[] = [];
        const declare = options.optimistic;
        const cache = getDataCache();
        if (declare === undefined || cache === null)
        {
            return { layers, touched };
        }
        const patch = (target: unknown, argsOrNext: unknown, maybeNext?: unknown): void =>
        {
            const family = cachedFamilyOf(target);
            if (family === null)
            {
                throw new TypeError('[azeroth] createMutation: a patch targets a cached(...) fetcher. '
                    + 'An optimistic value has to live on the shared entry, or no other reader of '
                    + 'the same data can see it.');
            }
            const hasArgs = maybeNext !== undefined;
            const args = hasArgs ? argsOrNext as unknown[] : [];
            const next = (hasArgs ? maybeNext : argsOrNext) as (value: unknown) => unknown;
            assertFunction(next, 'createMutation', 'a patch projection');
            const entry = cache.entryFor(family, args);
            layers.push({ entry, id: cache.patchEntry(entry, next) });
            touched.push({ fetcher: target as AnyCached, args });
        };
        batch(() => untrack(() => declare(input, patch as unknown as PatchFn)));
        return { layers, touched };
    }

    /**
     * What this run revalidates: the declared families, or - by default - exactly the entries it
     * guessed at. A patch aimed at one key revalidates that key rather than its whole family,
     * because that is the only entry the write is known to have changed.
     */
    function targets(touched: PatchTarget[]): PatchTarget[]
    {
        return options.invalidates === undefined
            ? touched
            : options.invalidates.map((fetcher) => ({ fetcher, args: [] }));
    }

    async function run(input: In, runOptions: { signal?: AbortSignal } = {}): Promise<MutationResult<Out>>
    {
        if (DEV && isStringMode())
        {
            console.warn('[azeroth] createMutation: run() during a server render is not a supported '
                + 'operation; a server render answers one request and has no one to show a guess to.');
        }
        // Checked BEFORE the guess: a dropped run must leave no trace at all, and applying
        // one only to withdraw it would flicker the screen for a click that did nothing.
        if (policy === 'drop' && running.size > 0)
        {
            return { ok: false, cancelled: true, error: new Error('A run of this mutation is already in flight.') };
        }
        if (policy === 'restart')
        {
            // The runs in flight are superseded, and go through the full cancel: their guesses
            // are withdrawn and each looks at what the server actually did.
            for (const inFlightRun of [...running])
            {
                inFlightRun.abort();
            }
        }
        const { layers, touched } = applyGuess(input);
        const controller = new AbortController();
        running.add(controller);
        // The caller's signal drives this run's, so one run can be cancelled without reaching
        // for the whole mutation - and `cancel()` still reaches it, through the same controller.
        const caller = runOptions.signal;
        const relay = (): void => controller.abort(caller?.reason);
        if (caller !== undefined)
        {
            if (caller.aborted)
            {
                relay();
            }
            else
            {
                caller.addEventListener('abort', relay, { once: true });
            }
        }
        const revalidateTargets = (): void =>
        {
            for (const target of targets(touched))
            {
                // Fired, not awaited: `run` answers when the SERVER has, and the correction
                // lands behind it. A caller that needs the refetch too awaits revalidate itself.
                // A rejection here is the resource's to report, not this call's.
                void revalidate(target.fetcher, target.args.length > 0 ? [...target.args] : undefined)
                    .catch(() => undefined);
            }
        };
        batch(() =>
        {
            setInFlight((count) => count + 1);
            setError(() => null);
        });
        // The `queue` policy's place in line, claimed at CALL time so the order is the order
        // runs were made in. The tail becomes THIS run's completion, not the previous one's, or
        // every queued run would start the moment its predecessor was merely dequeued.
        let leaveQueue: () => void = () => undefined;
        if (policy === 'queue')
        {
            const ahead = queued;
            queued = new Promise<void>((resolve) =>
            {
                leaveQueue = resolve;
            });
            await ahead;
        }
        // Read through a call, not the property: `aborted` flips DURING the await, and narrowing
        // it from the check above would make the one after the write look statically dead.
        const aborted = (): boolean => controller.signal.aborted;
        try
        {
            if (aborted())
            {
                // Cancelled while waiting its turn: it never reaches the server at all.
                return abandon(controller.signal.reason);
            }
            const data = await write(input, controller.signal);
            if (aborted())
            {
                // The write ignored its signal and finished anyway. The caller was told to
                // expect a cancel, so it gets one - but the server may well have committed,
                // which is exactly why the invalidation below still runs.
                return abandon(controller.signal.reason);
            }
            // The server accepted it, so the guess is now truth: folded into the entry before
            // anything else can read it, and the revalidation runs BEHIND that rather than the
            // screen waiting on a second round trip.
            batch(() =>
            {
                const cache = getDataCache();
                for (const layer of layers)
                {
                    cache?.settleLayer(layer.entry, layer.id);
                }
            });
            revalidateTargets();
            return { ok: true, data };
        }
        catch (failure)
        {
            if (aborted())
            {
                return abandon(failure);
            }
            batch(() =>
            {
                const cache = getDataCache();
                for (const layer of layers)
                {
                    cache?.dropLayer(layer.entry, layer.id);
                }
                setError(() => failure);
            });
            return { ok: false, error: failure };
        }
        finally
        {
            running.delete(controller);
            caller?.removeEventListener('abort', relay);
            setInFlight((count) => count - 1);
            leaveQueue();
        }

        /** Withdraws this run's guess and goes to look at what the server actually did. */
        function abandon(reason: unknown): MutationResult<Out>
        {
            batch(() =>
            {
                const cache = getDataCache();
                for (const layer of layers)
                {
                    cache?.dropLayer(layer.entry, layer.id);
                }
            });
            revalidateTargets();
            // `error()` is deliberately untouched: nothing failed, and a banner here would
            // report the user's own cancel back to them.
            return { ok: false, cancelled: true, error: reason };
        }
    }

    return {
        pending: () => inFlight() > 0,
        error,
        run,
        cancel(): void
        {
            // Copied first: aborting settles runs, which mutates the set being walked.
            for (const controller of [...running])
            {
                controller.abort();
            }
        }
    };
}
