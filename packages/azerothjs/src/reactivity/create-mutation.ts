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
}

/** One run's outcome. Never a rejection: a fire-and-forget call site must stay safe. */
export type MutationResult<Out> =
    | { ok: true; data: Out }
    | { ok: false; error: unknown };

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
     * Rejects only on MISUSE (see the module docblock); a write that fails answers
     * `{ ok: false, error }`.
     */
    run: (input: In) => Promise<MutationResult<Out>>;
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
    write: (input: In) => Promise<Out>,
    options: MutationOptions<In> = {}
): Mutation<In, Out>
{
    assertFunction(write, 'createMutation', 'the write function');

    const [inFlight, setInFlight] = createSignal(0, { name: 'mutation-in-flight' });
    const [error, setError] = createSignal<unknown>(null, { name: 'mutation-error' });

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

    async function run(input: In): Promise<MutationResult<Out>>
    {
        if (DEV && isStringMode())
        {
            console.warn('[azeroth] createMutation: run() during a server render is not a supported '
                + 'operation; a server render answers one request and has no one to show a guess to.');
        }
        const { layers, touched } = applyGuess(input);
        batch(() =>
        {
            setInFlight((count) => count + 1);
            setError(() => null);
        });
        try
        {
            const data = await write(input);
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
            for (const target of targets(touched))
            {
                // Fired, not awaited: `run` answers when the SERVER has, and the correction
                // lands behind it. A caller that needs the refetch too awaits revalidate itself.
                // A rejection here is the resource's to report, not this call's.
                void revalidate(target.fetcher, target.args.length > 0 ? [...target.args] : undefined)
                    .catch(() => undefined);
            }
            return { ok: true, data };
        }
        catch (failure)
        {
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
            setInFlight((count) => count - 1);
        }
    }

    return {
        pending: () => inFlight() > 0,
        error,
        run
    };
}
