// ============================================================================
// AZEROTHJS — createResource (Async Reactive Primitive)
// ============================================================================
//
// Wraps an async fetcher into reactive signals: `data`, `loading`,
// `error`, plus an imperative `refetch()`. The same primitive that
// drives every "data fetching" feature in the framework — route
// loaders, manual `useResource` calls, suspense integration.
//
// TWO CALLING FORMS:
//
//   1. Standalone fetcher
//      const user = createResource(async (signal) =>
//      {
//          const res = await fetch('/me', { signal });
//          return res.json();
//      });
//
//   2. With a source signal — re-runs when the source changes,
//      and the source value is passed to the fetcher.
//      const post = createResource(
//          () => postId(),
//          async (id, signal) =>
//          {
//              const res = await fetch(`/posts/${ id }`, { signal });
//              return res.json();
//          }
//      );
//
// SOURCE-FALSY SHORT-CIRCUIT:
//
//   If the source returns `false`, `null`, or `undefined`, the
//   fetcher is NOT invoked. `data` resets to `undefined`. This is
//   the universal "skip fetching" pattern — `() => isLoggedIn() && userId`.
//   `0` and `''` are NOT treated as falsy here; they're valid keys.
//
// CANCELLATION:
//
//   Each fetch gets its own `AbortController`. When the source
//   changes, `refetch()` is called, or the surrounding scope
//   disposes, the in-flight controller is aborted. The `signal`
//   threads to the fetcher so user code can opt into cancelling
//   `fetch`, IndexedDB, or any AbortSignal-aware async API.
//
// RACE-CONDITION GUARD:
//
//   When a new fetch supersedes an old one, the old controller is
//   aborted. If the old promise resolves anyway (network is
//   already in flight), we drop the result by checking
//   `signal.aborted` before applying it.
//
// ============================================================================

import type { Getter } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';

/**
 * The reactive shape returned by `createResource()`.
 *
 * @typeParam T - The type of the fetched value
 */
export interface Resource<T>
{
    /**
     * The most recently resolved value, or `undefined` if the
     * fetcher has never resolved (initial state, or source-falsy,
     * or fetch errored before producing a value).
     *
     * Reading this inside an effect subscribes the effect to
     * future changes — same contract as any signal getter.
     */
    data: Getter<T | undefined>;

    /**
     * Whether a fetch is currently in flight.
     *
     * `true` synchronously after construction (and after every
     * source change / `refetch()`), flips to `false` when the
     * fetcher resolves or rejects.
     */
    loading: Getter<boolean>;

    /**
     * The error from the most recent failed fetch, or `null` if
     * the latest fetch succeeded (or none has run).
     *
     * Cleared at the start of every new fetch.
     */
    error: Getter<unknown>;

    /**
     * Re-runs the fetcher with the current source value.
     *
     * If a fetch is in flight, it's aborted first. If the source
     * is currently falsy, `refetch` is a no-op — there's nothing
     * meaningful to refetch without a key.
     */
    refetch: () => void;
}

/**
 * The fetcher form when no source signal is provided.
 *
 * @typeParam T - The fetched value's type
 */
type StandaloneFetcher<T> = (signal: AbortSignal) => Promise<T>;

/**
 * The fetcher form when a source signal is provided.
 *
 * @typeParam S - The source value's type
 * @typeParam T - The fetched value's type
 */
type SourceFetcher<S, T> = (sourceValue: S, signal: AbortSignal) => Promise<T>;

/**
 * Wraps an async fetcher into a reactive `Resource`.
 *
 * Use the standalone form for one-shot loads, and the source
 * form when the fetch should re-run automatically as a signal
 * changes.
 *
 * Must be called inside a `createRoot()` (the surrounding
 * component or `render()` already provides one) so the in-flight
 * abort and the internal effect can be cleaned up on unmount.
 *
 * @example
 * ```ts
 * // Standalone — fetch once on construction.
 * const session = createResource(async (signal) =>
 * {
 *     const res = await fetch('/api/session', { signal });
 *     return res.json();
 * });
 *
 * createEffect(() =>
 * {
 *     if (session.loading()) console.log('loading…');
 *     else if (session.error()) console.error(session.error());
 *     else if (session.data()) console.log('user:', session.data());
 * });
 * ```
 *
 * @example
 * ```ts
 * // With source — re-runs when postId() changes.
 * const [postId, setPostId] = createSignal<number | null>(null);
 *
 * const post = createResource(
 *     () => postId(),
 *     async (id, signal) =>
 *     {
 *         const res = await fetch(`/api/posts/${ id }`, { signal });
 *         return res.json();
 *     }
 * );
 *
 * setPostId(1); // fetch starts with id=1
 * setPostId(2); // id=1 is aborted, id=2 starts
 * ```
 *
 * @example
 * ```ts
 * // Source-falsy short-circuit — fetcher does NOT run while
 * // userId is null. data() stays undefined.
 * const profile = createResource(
 *     () => userId(),
 *     async (id, signal) => loadProfile(id, signal)
 * );
 * ```
 */
export function createResource<T>(
    fetcher: StandaloneFetcher<T>
): Resource<T>;
export function createResource<T, S>(
    source: () => S | false | null | undefined,
    fetcher: SourceFetcher<S, T>
): Resource<T>;
export function createResource<T, S>(
    sourceOrFetcher: (() => S | false | null | undefined) | StandaloneFetcher<T>,
    maybeFetcher?: SourceFetcher<S, T>
): Resource<T>
{
    // Discriminate the two overloads by whether a second argument
    // was supplied. The standalone form passes the fetcher as the
    // first argument and nothing for the second.
    const hasSource = maybeFetcher !== undefined;
    const source = hasSource
        ? (sourceOrFetcher as () => S | false | null | undefined)
        : null;
    const fetcher = (hasSource ? maybeFetcher! : sourceOrFetcher) as
        | StandaloneFetcher<T>
        | SourceFetcher<S, T>;

    const [data, setData] = createSignal<T | undefined>(undefined);
    const [loading, setLoading] = createSignal<boolean>(false);
    const [error, setError] = createSignal<unknown>(null);

    // `tick` exists solely so `refetch()` has a signal to bump,
    // forcing the wrapper effect to re-run with the same source
    // value. Internal — never exposed.
    const [tick, setTick] = createSignal(0);

    /**
     * Returns true for the three values that mean "no key, don't
     * fetch": `false`, `null`, `undefined`. `0` and `''` are valid
     * keys — users can navigate to /post/0 or look up an empty-tag
     * search legitimately.
     */
    function isSkipValue(v: unknown): boolean
    {
        return v === null || v === undefined || v === false;
    }

    /**
     * Kicks off a fetch under the supplied controller. `loading`
     * flips to true synchronously; `data` and `error` are settled
     * by the promise.
     */
    function startFetch(controller: AbortController, sourceValue: S | undefined): void
    {
        // Group the synchronous "before" updates so subscribers
        // don't see a half-state where loading is true but the
        // previous error is still hanging around.
        batch(() =>
        {
            setLoading(true);
            setError(null);
        });

        const promise = hasSource
            ? (fetcher as SourceFetcher<S, T>)(sourceValue as S, controller.signal)
            : (fetcher as StandaloneFetcher<T>)(controller.signal);

        promise.then(
            (result) =>
            {
                // The promise might resolve AFTER a newer fetch
                // aborted us. Drop superseded results so they
                // don't overwrite fresher state.
                if (controller.signal.aborted)
                {
                    return;
                }

                batch(() =>
                {
                    // Wrapper-arrow form so `result` is stored
                    // verbatim even if it's itself a function.
                    setData(() => result);
                    setLoading(false);
                });
            },
            (err) =>
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
        );
    }

    // The reactive heart of the resource. Reads `tick` and `source`
    // — when either changes, the previous run's `onCleanup` aborts
    // the in-flight fetch, then this body kicks off the new one.
    createEffect(() =>
    {
        tick(); // subscribe so refetch() can force a re-run

        let sourceValue: S | undefined;
        if (source !== null)
        {
            const v = source();
            if (isSkipValue(v))
            {
                // No key → no fetch. Reset state to "nothing
                // loaded". Anything in flight from a previous run
                // was aborted by the cleanup that fired before us.
                batch(() =>
                {
                    setData(() => undefined);
                    setLoading(false);
                    setError(null);
                });
                return;
            }
            sourceValue = v as S;
        }

        const controller = new AbortController();
        startFetch(controller, sourceValue);

        // Aborting the controller on the next re-run (or root
        // dispose) is what gives us the cancellation guarantee.
        onCleanup(() => controller.abort());
    });

    return {
        data,
        loading,
        error,
        refetch(): void
        {
            setTick(t => t + 1);
        }
    };
}
