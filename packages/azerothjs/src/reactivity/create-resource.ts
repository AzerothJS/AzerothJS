/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * An async fetcher wrapped into reactive data, loading and error signals plus an imperative
 * refetch. This is the primitive behind route loaders, manual resource calls and suspense.
 *
 * A plain resource aborts its active request on a key change, refetch or disposal. Shared
 * entries own their requests and track their remaining readers. Both discard stale results.
 */

import type { EqualsFn, Getter } from './types.ts';
import type { CacheEntry, DataCache } from './data-cache.ts';
import { createSignal } from './create-signal.ts';
import { createEffect, routeAsyncError } from './create-effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';
import { assertFunction, describeArg } from './validate.ts';
import { currentErrorHandler } from './catch-error.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';
import { currentStreamSession, isHydrating, isStringMode } from './render-mode.ts';
import { hasSeedWindow, holdStreamSeed, type StreamSeed } from './stream-seeds.ts';
import { DEV } from './dev.ts';
import { untrack } from './untrack.ts';
import { invokeFetcher } from './invoke-fetcher.ts';
import { createSourceKey, type SourceKey } from './source-key.ts';
import { cachedFamilyOf, getDataCache, projectedValue, readValue as readCachedValue } from './data-cache.ts';

/**
 * The reactive shape returned by {@link createResource}.
 *
 * @typeParam T - The fetched value type.
 */
export interface Resource<T>
{
    /**
     * The most recently resolved value for the current key, or `undefined` while a new key
     * has no value or the source is skipped.
     */
    data: Getter<T | undefined>;

    /**
     * Whether a fetch without a successful value for this key is in flight. Flips true synchronously when one
     * starts and false once the fetcher settles. A background revalidation of data already
     * on screen reports through {@link Resource.refreshing} instead.
     */
    loading: Getter<boolean>;

    /**
     * Whether a background revalidation is in flight while `data()` still serves the
     * retained value for the same key, including a successful null or undefined result.
     */
    refreshing: Getter<boolean>;

    /** The most recent failure, or null. Cleared at the start of every fetch. */
    error: Getter<unknown>;

    /**
     * Requests a fresh read of the current key. Calls in one batch use its final key.
     * Resolves on the first authoritative result (success or failure) covering this call.
     * If the read is superseded, follows its replacement, including after a key change or
     * mutation. A new key with available data may already be settled. A skipped or throwing
     * source, disposal or string rendering releases the wait without a result. Reads started
     * after publication of the qualifying result have their own settlement.
     */
    refetch: () => Promise<void>;
}

/** Fetcher with no source signal. */
type StandaloneFetcher<T> = (signal: AbortSignal) => Promise<T>;

/** Fetcher driven by a source signal, which receives the resolved source value. */
type SourceFetcher<S, T> = (sourceValue: S, signal: AbortSignal) => Promise<T>;

/** Options for {@link createResource}. */
export interface ResourceOptions<T, S = unknown>
{
    /** Compares usable source keys without tracking. Defaults to Object.is in the source-driven form. */
    equals?: EqualsFn<S> | undefined;

    /**
     * Supplies an already settled value for the first key. The value is available immediately.
     * An explicit refetch in the construction batch adopts the seed and starts a fresh read.
     *
     * This is the SSR handoff seam. The server rendered with this data, so a client adopting
     * that markup can reuse it, and a synchronous server render can see it without waiting
     * for an effect. A different key fetches normally. A skipped key clears the seed.
     *
     * `undefined` is no seed: the resource fetches as if the option were absent. `null` is the
     * settled-empty seed, with a `T` that admits null, and `0`, `''` and `false` seed as written.
     */
    initialValue?: T | undefined;

    /**
     * Supplies an already settled failure. `error()` returns it synchronously. An explicit
     * refetch in the construction batch retries, as with {@link initialValue}.
     *
     * The other half of the SSR handoff seam. A server that could not load a level still
     * renders that level's own failure UI, so a client adopting the markup has to reach the
     * same state on its first pass - seeding the data instead (or leaving the level loading)
     * makes the client render something the server did not, which is an unrecoverable
     * hydration mismatch rather than a cosmetic one.
     *
     * `undefined` and `null` are no seed, since `error()` reads null when nothing failed. A seed
     * taken from a route loader passes `initialValue: loader.data()` together with
     * `initialError: loader.error()`, so a level the server could not load stays unfetched.
     */
    initialError?: unknown;

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
 * loads once, and source-driven, which re-runs when its logical key changes and
 * passes the source value to the fetcher. The fetcher runs synchronously up to its first
 * await with dependency tracking suspended. Pass a reactive fetch key as the source.
 * Explicit refetch and shared-cache invalidation can also start a request.
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
 * During stream hydration, a Suspense boundary supplies its watched resources' initial
 * outcomes when its marker is adopted. An initial setup read can therefore see loading.
 * A resource outside every adopted watch list starts its fetch when the hydration walk finishes.
 *
 * @typeParam T - The fetched value type.
 * @typeParam S - The source value type, in the source-driven form.
 * @param sourceOrFetcher - The fetcher, or the source getter in the source-driven form.
 * @param maybeFetcherOrOptions - The fetcher when a source was passed first, otherwise the
 *                                options bag.
 * @param maybeOptions - Options, in the source-driven form.
 * @param options.initialValue - Supplies a settled value for the initial automatic read;
 *                               `undefined` is no seed, and `null` is the settled-empty seed for a
 *                               `T` that admits null.
 * @param options.initialError - Seeds the resource as settled in the failed state; `undefined`
 *                               and `null` are no seed.
 * @returns A {@link Resource} of reactive getters plus `refetch`.
 * @throws {TypeError} If the first argument is not a function, which is the forgotten-thunk
 *                     shape `resource r = fetch(url)`; if the second is neither a fetcher
 *                     nor an options object, which is the same mistake one position over; or
 *                     if the source form's third is not an options object.
 * @example
 * // Standalone: loads once.
 * const config = createResource(async (signal) =>
 *     (await fetch('/api/config', { signal })).json());
 *
 * @example
 * // Source-driven: fetches when postId changes and skips a missing id.
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
 * Source-driven form. Fetches when the key changes according to `options.equals`
 * (Object.is by default) and passes the accepted key to the fetcher.
 *
 * A source returning `false`, `null` or `undefined` SKIPS the fetch and resets `data` to
 * undefined - the idiomatic way to wait for a parameter. `0` and `''` are valid keys.
 *
 * @typeParam T - The fetched value type.
 * @typeParam S - The source value type.
 * @param source - The fetch key. Only `false`, `null` and `undefined` skip.
 * @param fetcher - Receives the resolved source value and an AbortSignal.
 * @param options - Optional settings.
 * @param options.initialValue - Supplies a settled value for the initial automatic read;
 *                               `undefined` is no seed, and `null` is the settled-empty seed for a
 *                               `T` that admits null.
 * @param options.initialError - Seeds the resource as settled in the failed state; `undefined`
 *                               and `null` are no seed.
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
    options?: ResourceOptions<T, S>
): Resource<T>;
export function createResource<T, S>(
    sourceOrFetcher: (() => S | false | null | undefined) | StandaloneFetcher<T>,
    maybeFetcherOrOptions?: SourceFetcher<S, T> | ResourceOptions<T>,
    maybeOptions?: ResourceOptions<T, S>
): Resource<T>
{
    return buildResource(sourceOrFetcher, maybeFetcherOrOptions, maybeOptions);
}

/** A loader handoff belongs to one key once its initial route has been admitted. @internal */
export interface ResourceSeedKey<S>
{
    key: S;
    status: Getter<'pending' | 'accepted' | 'discarded'>;
}

/** @internal Hooks for a route level exposing generation-bound views of one resource. */
export interface ResourceKeyObserver<S, T>
{
    connect(resource: Resource<T>, refetch: (key: S) => Promise<void>): void;
    move(key: S | undefined): void;
    attach(key: S | undefined): void;
}

// A buffered resource can await its first read while its public loading flag is false.
// Key by the getter so a view forwarding the resource's signals retains that state.
let bufferedColdLoads: WeakSet<Getter<boolean>> | undefined;

/** Whether a buffered Suspense boundary needs this resource's fallback. @internal */
export function isBufferedResourcePending(resource: Resource<unknown>): boolean
{
    const loading = resource.loading;
    return bufferedColdLoads?.has(loading) === true || loading.call(resource);
}

/** The implementation shared by the public overloads and the router's keyed handoff. @internal */
export function buildResource<T, S>(
    sourceOrFetcher: (() => S | false | null | undefined) | StandaloneFetcher<T>,
    maybeFetcherOrOptions?: SourceFetcher<S, T> | ResourceOptions<T>,
    maybeOptions?: ResourceOptions<T, S>,
    seedKey?: ResourceSeedKey<S>,
    keyObserver?: ResourceKeyObserver<S, T>
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
    // A third argument that is not an options object would otherwise read as no options at all.
    if (hasSource && maybeOptions !== undefined && !isOptionsBag(maybeOptions))
    {
        throw new TypeError(`createResource expects an options object as its third argument, received ${ describeArg(maybeOptions) }.`);
    }
    const source = hasSource
        ? (sourceOrFetcher as () => S | false | null | undefined)
        : null;
    const fetcher = (hasSource ? maybeFetcherOrOptions : sourceOrFetcher) as
        | StandaloneFetcher<T>
        | SourceFetcher<S, T>;
    const options = hasSource ? maybeOptions : maybeFetcherOrOptions;

    // Each option is read once, so the seed decision and the stored seed come from one read.
    const initialValue = options?.initialValue;
    const initialError = options?.initialError;
    // The seed itself, from the options or the streamed seed below. Both present is a failure.
    let seedFailure = initialError !== undefined && initialError !== null;
    let seedValue: T | undefined = initialValue;
    // The hydration seed, consumed or discarded at the effect's first run. See ResourceOptions.
    // An explicit refetch in the construction batch still demands a fresh read.
    const initialStatus = seedKey === undefined ? 'accepted' : untrack(seedKey.status);
    let pendingInitial = initialStatus !== 'discarded' && (seedFailure || initialValue !== undefined);
    const showSeed = initialStatus === 'accepted';
    // A failure seed belongs to this instance until an explicit retry or shared outcome.
    let seededFailureHeld = false;

    // Captured at construction, as an effect captures its catchError scope: a subscriber that
    // throws while this resource settles has nowhere else to send the error, because the settle
    // runs in a promise reaction outside any effect's stack.
    const settleErrorHandler = currentErrorHandler;

    const frame = dtEnterPrimitive('resource', options?.name);
    const [data, setData] = createSignal<T | undefined>(showSeed ? initialValue : undefined, { name: 'data' });
    const [loading, setLoading] = createSignal<boolean>(false, { name: 'loading' });
    const [refreshing, setRefreshing] = createSignal<boolean>(false, { name: 'refreshing' });
    const [error, setError] = createSignal<unknown>(showSeed && seedFailure ? initialError : null, { name: 'error' });

    // refetch() bumps `tick` to force the effect to re-run on the same source value.
    const [tick, setTick] = createSignal(0, { name: 'tick' });

    // A `cached` fetcher routes every fetch through the scope's shared registry: entries own
    // the fetches, this instance subscribes and mirrors. Plain fetches belong to the instance.
    const family = cachedFamilyOf(fetcher);
    let cacheRef: DataCache | null = null;
    let currentEntry: CacheEntry | null = null;
    let stopObserving: (() => void) | undefined;
    let unregisterSeed: (() => void) | undefined;
    let disposed = false;
    const stringMode = isStringMode();
    let requested = 0;
    let driven = 0;
    let hasValue = showSeed && !seedFailure && initialValue !== undefined;
    const waiters: Array<{ request: number; resolve: () => void; key: S | undefined }> = [];

    function finishRequests(through: number): void
    {
        let count = 0;
        for (const waiter of waiters)
        {
            if (waiter.request > through)
            {
                break;
            }
            waiter.resolve();
            count++;
        }
        if (count > 0)
        {
            waiters.splice(0, count);
        }
    }

    function leaveEntry(): void
    {
        stopObserving?.();
        stopObserving = undefined;
        if (cacheRef !== null && currentEntry !== null)
        {
            cacheRef.unsubscribe(currentEntry);
            currentEntry = null;
        }
    }

    // Instance disposal releases the shared-entry subscription; per-run cleanup would drop
    // it on every re-run and churn the entry through transient zeros.
    onCleanup(() =>
    {
        disposed = true;
        unregisterSeed?.();
        leaveEntry();
        finishRequests(Infinity);
    });

    // Mirrors the shared entry into this instance's signals, in one batch. The entry's
    // in-flight state is synchronous, so the initiator of a fetch sees loading immediately.
    function mirrorEntry(entry: CacheEntry): void
    {
        const fetching = entry.inflight !== null;
        if (seededFailureHeld && !entry.hasValue && !entry.hasError)
        {
            // Keep the seeded failure until the entry settles; only report the fetch in flight.
            setLoading(fetching);
            return;
        }
        seededFailureHeld = false;
        batch(() =>
        {
            setData(() => projectedValue(entry) as T | undefined);
            setError(() => (entry.hasError ? entry.error : null));
            setLoading(fetching && !entry.hasValue);
            setRefreshing(fetching && entry.hasValue);
        });
    }

    // The three values meaning "no key, do not fetch". 0 and '' are valid keys.
    function isSkipValue(v: unknown): boolean
    {
        return v === null || v === undefined || v === false;
    }

    // Returns the settle chain: the streaming driver awaits it, the effect path ignores it.
    function startFetch(controller: AbortController, sourceValue: S | undefined, request: number): Promise<void>
    {
        // Batched so subscribers never see loading=true with the previous error still set.
        batch(() =>
        {
            if (!hasValue)
            {
                setData(() => undefined);
            }
            setLoading(!hasValue);
            setRefreshing(hasValue);
            setError(null);
        });

        // Invoked SYNCHRONOUSLY, so a fetcher that registers an abort listener does so before a
        // superseding navigation can abort it. Guarded, so a fetcher that throws synchronously or
        // returns a non-promise joins the same settle path below instead of escaping with loading
        // stuck true forever.
        let pending: Promise<T>;
        try
        {
            pending = Promise.resolve(invokeFetcher(fetcher, undefined, () => hasSource
                ? (fetcher as SourceFetcher<S, T>)(sourceValue as S, controller.signal)
                : (fetcher as StandaloneFetcher<T>)(controller.signal)));
        }
        catch (error)
        {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the fetcher's thrown value propagates VERBATIM to error(); wrapping it would change what consumers observe
            pending = Promise.reject(error);
        }

        function settle(outcome: { value: T } | { error: unknown }): void
        {
            if (controller.signal.aborted)
            {
                return;
            }
            // A later boundary may only replace the first fetch while it is pending.
            unregisterSeed?.();
            unregisterSeed = undefined;
            try
            {
                batch(() =>
                {
                    if ('value' in outcome)
                    {
                        hasValue = true;
                        setData(() => outcome.value);
                    }
                    else
                    {
                        setError(() => outcome.error);
                    }
                    setLoading(false);
                    setRefreshing(false);
                });
            }
            catch (observerError)
            {
                // An observer threw during publication. Deliver it to the construction scope
                // before making the accepted fetch visible to code awaiting refetch().
                routeAsyncError(observerError, settleErrorHandler, options?.name);
            }
            finally
            {
                finishRequests(request);
            }
        }

        return pending.then(result => settle({ value: result }), (error: unknown) => settle({ error }));
    }

    // The string-mode variant of startFetch for cached fetchers: same instance-signal settle
    // shape (Suspense and the seed serializer read these), fetch shared through the registry.
    function startCachedStringFetch(cache: DataCache, controller: AbortController, sourceValue: S | undefined): Promise<void>
    {
        batch(() =>
        {
            setLoading(true);
            setError(null);
        });
        const args = source !== null ? [sourceValue] : [];
        return readCachedValue<T>(cache, family as NonNullable<typeof family>, args, controller.signal).then(
            (result) =>
            {
                if (controller.signal.aborted)
                {
                    return;
                }
                batch(() =>
                {
                    setData(() => result);
                    setLoading(false);
                });
            },
            (failure: unknown) =>
            {
                if (controller.signal.aborted)
                {
                    return;
                }
                batch(() =>
                {
                    setError(() => failure);
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
        refreshing,
        error,
        refetch: () => requestRead()
    };

    function requestRead(key?: S): Promise<void>
    {
        if (disposed || stringMode)
        {
            return Promise.resolve();
        }
        const request = ++requested;
        const settled = new Promise<void>(resolve => waiters.push({ request, resolve, key }));
        setTick(request);
        return settled;
    }
    keyObserver?.connect(resource, requestRead);

    if (stringMode)
    {
        // Effects never run in string mode, so inside a streaming session the fetch starts here,
        // eagerly at creation, and fetch time overlaps serialization. Suspense matches the
        // registered promise to the resource at its original position in the watch list.
        const session = currentStreamSession();
        if (session !== null)
        {
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
                    // A cached fetcher reads through the render frame's registry, so two
                    // same-key resources in one pass share one fetch; the waiter it holds
                    // and the chained controller are the entry's abort audience.
                    const cache = family !== null ? getDataCache() : null;
                    const promise = family !== null && cache !== null
                        ? startCachedStringFetch(cache, controller, sourceValue as S | undefined)
                        : startFetch(controller, sourceValue as S | undefined, 0);
                    session.registerFetch(resource, {
                        promise,
                        controller,
                        name: DEV ? options?.name ?? fetcher.name : undefined,
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
        else if (!pendingInitial)
        {
            bufferedColdLoads ??= new WeakSet();
            bufferedColdLoads.add(loading);
        }
        dtExitPrimitive(frame);
        return resource;
    }

    const readKey = source === null ? undefined : createSourceKey(source, options?.equals, tick);
    let previousKey: SourceKey<S> | undefined;

    // The hydration wakeup is independent of tick, whose value identifies a public
    // refetch and its waiters. Both a release and a seed must re-enter the owning effect.
    const seedDrive = isHydrating() && keyObserver === undefined && !pendingInitial
        ? createSignal(0) : undefined;
    // If the shell hydrates before any chunks arrive, keep the usual first fetch. A
    // boundary adopted later can still seed that original request while it is pending.
    let held = seedDrive !== undefined && hasSeedWindow();
    let initialKeyKnown = held;
    let initialKey = held && readKey ? untrack(readKey) : undefined;
    let initialFlight: CacheEntry['inflight'] = null;

    function stopSeed(): void
    {
        held = false;
        unregisterSeed?.();
        unregisterSeed = undefined;
    }

    function applySeed(seed: StreamSeed): boolean
    {
        if (disposed || !initialKeyKnown || requested !== 0 || (readKey && untrack(readKey) !== initialKey))
        {
            return false;
        }

        const cache = family === null ? null : getDataCache();
        const entry = family !== null && cache !== null
            ? cache.entryFor(family, initialKey?.kind === 'value' ? [initialKey.value] : [])
            : null;
        if (entry && !entry.hasValue && !entry.hasError
            && (entry.markSeq !== 0 || entry.inflight !== initialFlight))
        {
            // Another reader started or invalidated this key. Its generation owns the answer.
            return false;
        }

        stopSeed();
        batch(() =>
        {
            pendingInitial = true;
            if (entry && (entry.hasValue || entry.hasError))
            {
                seedValue = entry.value as T;
                seedFailure = !entry.hasValue && entry.hasError;
                hasValue = entry.hasValue;
                mirrorEntry(entry);
            }
            else
            {
                seedValue = seed.d as T;
                seedFailure = seed.e !== undefined;
                hasValue = !seedFailure;
                if (!seedFailure && cache && entry)
                {
                    // Publish now, in the same batch as the boundary's other seeds. A
                    // sibling may invalidate or fetch this entry before our first drive.
                    cache.writeEntry(entry, seedValue);
                    mirrorEntry(entry);
                }
                else
                {
                    if (cache && entry && initialFlight)
                    {
                        cache.cancelSoleSeedRead(entry, initialFlight);
                    }
                    setData(() => seedValue);
                    setError(() => seed.e === undefined ? null : new Error(seed.e));
                    setLoading(false);
                    setRefreshing(false);
                }
            }
            seedDrive?.[1](revision => revision + 1);
        });
        return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the source getter above can synchronously dispose the construction scope
    if (seedDrive && (initialKey === undefined || initialKey.kind === 'value') && !disposed)
    {
        if (held)
        {
            setLoading(true);
        }
        unregisterSeed = holdStreamSeed(resource, applySeed, () =>
        {
            held = false;
            seedDrive[1](revision => revision + 1);
        }, DEV ? options?.name ?? fetcher.name : undefined);
    }

    function driveEntry(cache: DataCache, entry: CacheEntry, force: boolean, request: number): void
    {
        const entering = entry !== currentEntry;
        const fromZero = entry.subscribers === 0;
        if (entering)
        {
            leaveEntry();
            cacheRef = cache;
            currentEntry = entry;
            cache.subscribe(entry);
        }

        const streamSeed = pendingInitial && seedDrive !== undefined;
        const adopting = pendingInitial && (!streamSeed || seedFailure || entry.hasValue);
        pendingInitial = false;
        if (adopting)
        {
            seededFailureHeld = seedFailure;
            if (!seedFailure && !entry.hasValue)
            {
                cache.writeEntry(entry, seedValue);
            }
        }
        entry.version();
        if (force)
        {
            seededFailureHeld = false;
            cache.restart(entry);
        }
        else if (!adopting || ((streamSeed || seedKey !== undefined) && entry.stale))
        {
            const canReplace = unregisterSeed !== undefined && entering && entry.inflight === null
                && !entry.hasValue && !entry.hasError && entry.markSeq === 0;
            cache.read(entry, { subscribing: entering, fromZero });
            if (canReplace)
            {
                initialFlight = entry.inflight;
            }
            if (unregisterSeed && (!initialFlight || initialFlight !== entry.inflight || entry.markSeq !== 0))
            {
                stopSeed();
            }
        }

        // Cache invalidations and mutation landings can replace a fetch without another
        // resource run. The cache's generation-qualified settlement is authoritative.
        if ((entering || force) && waiters.length > 0)
        {
            stopObserving?.();
            stopObserving = cache.observeFetch(entry, () => finishRequests(request));
        }
        // A prefetch may have settled while a loader's admission was pending. Mirror its
        // newer outcome. mirrorEntry keeps a private failure seed if the entry has none.
        if (seedKey !== undefined || !adopting || !seedFailure || force)
        {
            mirrorEntry(entry);
        }
    }

    createEffect(() =>
    {
        const request = tick();
        let force = request !== driven;
        const key = readKey?.();
        if (unregisterSeed)
        {
            seedDrive?.[0]();
            if (!initialKeyKnown)
            {
                initialKey = key;
                initialKeyKnown = true;
            }
            if (force || key !== initialKey || (key !== undefined && key.kind !== 'value'))
            {
                stopSeed();
            }
            else if (held)
            {
                return;
            }
        }
        if (seedDrive && pendingInitial && key !== initialKey)
        {
            pendingInitial = false;
            hasValue = false;
        }
        // A source can synchronously unmount the component that asked for this read.
        if (disposed)
        {
            if (key?.kind === 'error')
            {
                throw key.error;
            }
            return;
        }
        const changed = key !== previousKey;
        if (keyObserver !== undefined)
        {
            const value = key?.kind === 'value' ? key.value : undefined;
            if (changed)
            {
                untrack(() => keyObserver.move(value));
            }
            if (waiters.length !== 0)
            {
                // A scoped request can only force its own key, including when navigation
                // and refetch coalesce. Ordinary callers retain follow-the-winner semantics.
                force = false;
                let kept = 0;
                for (const waiter of waiters)
                {
                    if (waiter.key !== undefined && !Object.is(waiter.key, value))
                    {
                        waiter.resolve();
                    }
                    else
                    {
                        waiters[kept++] = waiter;
                        force ||= waiter.request > driven && waiter.request <= request;
                    }
                }
                waiters.length = kept;
            }
        }
        driven = request;
        previousKey = key;
        if (key !== undefined && key.kind !== 'value')
        {
            leaveEntry();
            hasValue = false;
            pendingInitial = pendingInitial && key.kind === 'skip' && seedKey !== undefined
                && untrack(seedKey.status) === 'pending';
            seededFailureHeld = false;
            try
            {
                batch(() =>
                {
                    setData(() => undefined);
                    setLoading(false);
                    setRefreshing(false);
                    setError(null);
                });
            }
            finally
            {
                finishRequests(request);
            }
            if (key.kind === 'error')
            {
                throw key.error;
            }
            return;
        }

        const value = key?.value;
        if (pendingInitial && seedKey !== undefined)
        {
            pendingInitial = Object.is(value, seedKey.key) && untrack(seedKey.status) === 'accepted';
            hasValue = pendingInitial && !seedFailure;
            if (pendingInitial)
            {
                // A skipped source hides the seed until the guard admits the owning key.
                setData(() => seedValue);
                setError(() => seedFailure ? initialError : null);
            }
        }
        if (family !== null)
        {
            const cache = getDataCache();
            if (cache !== null)
            {
                try
                {
                    const entry = cache.entryFor(family, key === undefined ? [] : [value]);
                    driveEntry(cache, entry, force, request);
                    if (changed)
                    {
                        keyObserver?.attach(value);
                    }
                }
                catch (error)
                {
                    finishRequests(request);
                    throw error;
                }
                return;
            }
            leaveEntry();
        }

        const adopting = pendingInitial;
        pendingInitial = false;
        if (adopting && !force)
        {
            keyObserver?.attach(value);
            return;
        }
        if (changed && !adopting)
        {
            hasValue = false;
        }
        const controller = new AbortController();
        onCleanup(() => controller.abort());
        void startFetch(controller, value, request);
        if (changed)
        {
            keyObserver?.attach(value);
        }
    }, { name: 'fetch' });
    dtExitPrimitive(frame);

    return resource;
}
