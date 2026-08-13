/**
 * An async fetcher wrapped into reactive data, loading and error signals plus an imperative
 * refetch. This is the primitive behind route loaders, manual resource calls and suspense.
 *
 * Every fetch gets its own AbortController, and a source change, a refetch or scope
 * disposal aborts the one in flight. A superseded fetch that resolves anyway is dropped
 * rather than applied, so a slow old response can never overwrite newer state.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect, routeAsyncError } from './create-effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';
import { assertFunction, describeArg } from './validate.ts';
import { currentErrorHandler } from './catch-error.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';
import { currentStreamSession, isHydrating, isStringMode } from './render-mode.ts';
import { allocateSeedId, takeStreamSeed } from './stream-seeds.ts';
import { untrack } from './untrack.ts';

/**
 * The reactive shape returned by {@link createResource}.
 *
 * @typeParam T - The fetched value type.
 */
export interface Resource<T>
{
    /**
     * The most recently resolved value, or `undefined` before the first one lands, while the
     * source is falsy, or when the fetch failed before producing a value.
     */
    data: Getter<T | undefined>;

    /**
     * Whether a fetch is in flight. Flips true synchronously when one starts and false once
     * the fetcher settles.
     */
    loading: Getter<boolean>;

    /** The most recent failure, or null. Cleared at the start of every fetch. */
    error: Getter<unknown>;

    /**
     * Re-runs the fetcher with the current source value, aborting anything in flight first.
     * A no-op while the source is falsy, since there is no key to fetch.
     */
    refetch: () => void;
}

/** Fetcher with no source signal. */
type StandaloneFetcher<T> = (signal: AbortSignal) => Promise<T>;

/** Fetcher driven by a source signal, which receives the resolved source value. */
type SourceFetcher<S, T> = (sourceValue: S, signal: AbortSignal) => Promise<T>;

/** Options for {@link createResource}. */
export interface ResourceOptions<T>
{
    /**
     * Seeds the resource as ALREADY SETTLED: `data()` returns this synchronously and the
     * first fetch is skipped entirely, so `loading` never flips.
     *
     * This is the SSR handoff seam. The server rendered with this data, so a client adopting
     * that markup must not refetch it, and a synchronous server render must see it without
     * waiting for an effect. Everything after the first key behaves normally - a source
     * change fetches, refetch fetches, and a skip-key reset discards the seed along with the
     * data it clears.
     */
    initialValue?: T;

    /** Debug name for devtools; groups the resource's data, loading, error and fetch nodes. */
    name?: string;
}

/**
 * Whether a value could be the options bag rather than a misplaced fetcher value.
 *
 * "Any object" would defeat the guard entirely: a promise is an object, and
 * `resource r = fetch(url) with { source: id }` emits `createResource(() => id(), fetch(url))`.
 * Classifying that promise as options makes the overload discrimination promote the SOURCE
 * THUNK into the fetcher slot, so the resource resolves to the source key and serves it as
 * data - silently, and under SSR that wrong value is what gets serialized and hydrated.
 * Thenables and arrays are therefore excluded.
 *
 * Takes `unknown` deliberately: the declared parameter type rules out null, but this runs
 * against values the types never saw - compiled output and untyped JavaScript callers - and
 * narrowing to the declared type would make the check provably dead.
 */
function isOptionsBag(value: unknown): boolean
{
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        return false;
    }
    return typeof (value as { then?: unknown }).then !== 'function';
}

/**
 * Wraps an async fetcher into a reactive {@link Resource}. Two forms: standalone, which
 * loads once, and source-driven, which re-runs whenever its source signal changes and
 * passes the source value to the fetcher.
 *
 * A source returning `false`, `null` or `undefined` SKIPS the fetch and resets `data` to
 * undefined - the idiomatic way to wait for a parameter. `0` and `''` are valid keys, not
 * skip values.
 *
 * Create it inside a scope: a component or render() provides one. Unowned, neither the
 * internal effect nor a pending fetch is cleaned up on unmount. The fetcher should honour
 * the AbortSignal it receives, since cancellation otherwise only drops the result rather
 * than stopping the network work.
 *
 * The synchronous state updates are batched, so subscribers never observe `loading` true
 * with a stale error still set.
 *
 * @typeParam T - The fetched value type.
 * @typeParam S - The source value type, in the source-driven form.
 * @param sourceOrFetcher - The fetcher, or the source getter in the source-driven form.
 * @param maybeFetcherOrOptions - The fetcher when a source was passed first, otherwise the
 *                                options bag.
 * @param maybeOptions - Options, in the source-driven form.
 * @returns A {@link Resource} of reactive getters plus `refetch`.
 * @throws {TypeError} If the first argument is not a function, which is the forgotten-thunk
 *                     shape `resource r = fetch(url)`; or if the second is neither a fetcher
 *                     nor an options object, which is the same mistake one position over.
 * @example
 * // Standalone: loads once.
 * const config = createResource(async (signal) =>
 *     (await fetch('/api/config', { signal })).json());
 *
 * @example
 * // Source-driven: refetches whenever postId changes, and skips entirely while it is falsy.
 * const post = createResource(
 *     () => postId(),
 *     async (id, signal) => (await fetch(`/api/posts/${ id }`, { signal })).json()
 * );
 *
 * post.loading(); // true while in flight
 * post.data();    // T | undefined
 * post.error();   // unknown | null
 * post.refetch(); // abort and load again
 *
 * @see {@link createMemo} for synchronous derivations.
 */
export function createResource<T>(
    fetcher: StandaloneFetcher<T>,
    options?: ResourceOptions<T>
): Resource<T>;
/**
 * Source-driven form: re-fetches whenever `source` changes, passing its resolved value to the
 * fetcher.
 *
 * A source returning `false`, `null` or `undefined` SKIPS the fetch and resets `data` to
 * undefined - the idiomatic way to wait for a parameter. `0` and `''` are valid keys.
 *
 * @typeParam T - The fetched value type.
 * @typeParam S - The source value type.
 * @param source - The fetch key. Falsy values skip.
 * @param fetcher - Receives the resolved source value and an AbortSignal.
 * @param options - Optional settings.
 * @param options.initialValue - Seeds the resource as already settled, skipping the first fetch.
 * @param options.name - Debug name for devtools.
 * @returns A {@link Resource} of reactive getters plus `refetch`.
 * @example
 * const post = createResource(
 *     () => postId(),
 *     async (id, signal) => (await fetch(`/api/posts/${ id }`, { signal })).json()
 * );
 */
export function createResource<T, S>(
    source: () => S | false | null | undefined,
    fetcher: SourceFetcher<S, T>,
    options?: ResourceOptions<T>
): Resource<T>;
export function createResource<T, S>(
    sourceOrFetcher: (() => S | false | null | undefined) | StandaloneFetcher<T>,
    maybeFetcherOrOptions?: SourceFetcher<S, T> | ResourceOptions<T>,
    maybeOptions?: ResourceOptions<T>
): Resource<T>
{
    // Both overloads take a callable first. A non-function here is the `resource r = fetch(url)`
    // shape: the keyword's value is a verbatim expression the compiler never inspects, so a
    // forgotten thunk arrives as a PROMISE. That used to settle asynchronously to "fetcher is not
    // a function" on error(), surfacing far from the call that caused it.
    assertFunction(sourceOrFetcher, 'createResource',
        'Pass the fetcher as a function: createResource(async (signal) => (await fetch(url, { signal })).json()).');

    // The same forgotten thunk one position over: `resource r = 5 with { source: id }` emits
    // `createResource(() => id(), 5)`, and the discrimination below would quietly promote the
    // SOURCE to fetcher and treat `5` as options, fetching the source's value as if it were data.
    // Worse than a hang, because it looks like it worked.
    if (maybeFetcherOrOptions !== undefined
        && typeof maybeFetcherOrOptions !== 'function'
        && !isOptionsBag(maybeFetcherOrOptions))
    {
        throw new TypeError('createResource expects the fetcher or an options object as its second '
            + `argument, received ${ describeArg(maybeFetcherOrOptions) }. With \`with { source }\`, `
            + 'the value must be a function of the source: resource r = (id) => load(id) with { source: id }.');
    }

    const hasSource = typeof maybeFetcherOrOptions === 'function';
    const source = hasSource
        ? (sourceOrFetcher as () => S | false | null | undefined)
        : null;
    const fetcher = (hasSource ? maybeFetcherOrOptions : sourceOrFetcher) as
        | StandaloneFetcher<T>
        | SourceFetcher<S, T>;
    const options = hasSource ? maybeOptions : maybeFetcherOrOptions;

    // The hydration seed, consumed or discarded at the effect's first run. See ResourceOptions.
    let pendingInitial = options !== undefined && 'initialValue' in options;

    // Captured at construction, as an effect captures its catchError scope: a subscriber that
    // throws while this resource settles has nowhere else to send the error, because the settle
    // runs in a promise reaction outside any effect's stack.
    const settleErrorHandler = currentErrorHandler;

    const frame = dtEnterPrimitive('resource', options?.name);
    const [data, setData] = createSignal<T | undefined>(options?.initialValue, { name: 'data' });
    const [loading, setLoading] = createSignal<boolean>(false, { name: 'loading' });
    const [error, setError] = createSignal<unknown>(null, { name: 'error' });

    // refetch() bumps `tick` to force the effect to re-run on the same source value.
    const [tick, setTick] = createSignal(0, { name: 'tick' });

    // The three values meaning "no key, do not fetch". 0 and '' are valid keys.
    function isSkipValue(v: unknown): boolean
    {
        return v === null || v === undefined || v === false;
    }

    // Returns the settle chain: the streaming driver awaits it, the effect path ignores it.
    function startFetch(controller: AbortController, sourceValue: S | undefined): Promise<void>
    {
        // Batched so subscribers never see loading=true with the previous error still set.
        batch(() =>
        {
            setLoading(true);
            setError(null);
        });

        // Invoked SYNCHRONOUSLY, so a fetcher that registers an abort listener does so before a
        // superseding navigation can abort it. Guarded, so a fetcher that throws synchronously or
        // returns a non-promise joins the same settle path below instead of escaping with loading
        // stuck true forever.
        let pending: Promise<T>;
        try
        {
            pending = Promise.resolve(hasSource
                ? (fetcher as SourceFetcher<S, T>)(sourceValue as S, controller.signal)
                : (fetcher as StandaloneFetcher<T>)(controller.signal));
        }
        catch (error)
        {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the fetcher's thrown value propagates VERBATIM to error(); wrapping it would change what consumers observe
            pending = Promise.reject(error);
        }

        // The terminal catch is load-bearing: both settle arms run batch(), whose flush rethrows
        // the first error a queued subscriber threw, and here that lands in a promise reaction
        // with nothing downstream - an unhandled rejection, which kills the process on Node. It
        // never swallows a FETCHER failure; the arm above has already captured that in error().
        return pending.then(
            (result) =>
            {
                // May resolve after a newer fetch aborted this one.
                if (controller.signal.aborted)
                {
                    return;
                }

                batch(() =>
                {
                    // Wrapper-arrow form, so a function result is stored rather than called.
                    setData(() => result);
                    setLoading(false);
                });
            },
            (err: unknown) =>
            {
                if (controller.signal.aborted)
                {
                    return;
                }

                batch(() =>
                {
                    setError(() => err);
                    setLoading(false);
                });
            }
        ).catch((err: unknown) =>
        {
            routeAsyncError(err, settleErrorHandler, options?.name);
        });
    }

    const resource: Resource<T> = {
        data,
        loading,
        error,
        refetch(): void
        {
            setTick(t => t + 1);
        }
    };

    if (isStringMode())
    {
        // Effects never run in string mode, so inside a streaming session the fetch starts here,
        // eagerly at creation, and fetch time overlaps serialization. The session records the
        // settle promise under a scoped-ordinal id; Suspense awaits it, and the chunk carries the
        // id so hydration seeds this same resource.
        const session = currentStreamSession();
        if (session !== null)
        {
            const id = session.allocateResourceId();
            if (!pendingInitial)
            {
                const sourceValue = source !== null ? untrack(source) : undefined;
                if (source === null || !isSkipValue(sourceValue))
                {
                    const controller = new AbortController();
                    if (session.signal !== undefined)
                    {
                        if (session.signal.aborted)
                        {
                            controller.abort();
                        }
                        else
                        {
                            session.signal.addEventListener('abort', () => controller.abort(), { once: true });
                        }
                    }
                    const promise = startFetch(controller, sourceValue as S | undefined);
                    session.registerFetch(resource, {
                        promise,
                        controller,
                        id,
                        read: (): { d?: unknown; e?: string } =>
                        {
                            const failure = untrack(error);
                            if (failure !== null)
                            {
                                // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the wire seed is documented LOSSY: a non-Error failure degrades to its string form, visibly
                                return { e: failure instanceof Error ? failure.message : String(failure) };
                            }
                            return { d: untrack(data) };
                        }
                    });
                }
            }
        }
        dtExitPrimitive(frame);
        return resource;
    }

    if (isHydrating())
    {
        // A streamed page merged this resource's outcome into the seed store under the same
        // scoped-ordinal id the server allocated. The id ticks UNCONDITIONALLY so the counting
        // stays aligned; a miss, or a page that was never streamed, is ordinary behaviour.
        const id = allocateSeedId();
        if (!pendingInitial)
        {
            const seed = takeStreamSeed(id);
            if (seed !== undefined)
            {
                if ('d' in seed)
                {
                    setData(() => seed.d as T);
                }
                else if (seed.e !== undefined)
                {
                    setError(() => new Error(seed.e));
                }
                pendingInitial = true;
            }
        }
    }

    // Reads `tick` and `source`. On either change the previous run's onCleanup aborts the fetch
    // in flight, then this body starts the next one.
    createEffect(() =>
    {
        tick(); // subscribe so refetch() can force a re-run

        let sourceValue: S | undefined;
        if (source !== null)
        {
            const v = source();
            if (isSkipValue(v))
            {
                // No key, no fetch: reset to "nothing loaded". Anything in flight was already
                // aborted by the cleanup that ran before this body.
                batch(() =>
                {
                    setData(() => undefined);
                    setLoading(false);
                    setError(null);
                });
                pendingInitial = false; // the reset cleared the seeded data; the seed is gone
                return;
            }
            sourceValue = v as S;
        }

        if (pendingInitial)
        {
            // The seed IS this key's result: data() has served it since construction, loading
            // never flips, and no fetch happens. The SSR adoption path.
            pendingInitial = false;
            return;
        }

        const controller = new AbortController();
        void startFetch(controller, sourceValue);

        // Aborting on the next re-run, or at disposal, is the cancellation guarantee.
        onCleanup(() => controller.abort());
    }, { name: 'fetch' });
    dtExitPrimitive(frame);

    return resource;
}
