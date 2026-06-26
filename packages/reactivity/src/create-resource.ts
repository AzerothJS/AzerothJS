/**
 * MODULE: reactivity/create-resource
 *
 * createResource wraps an async fetcher into reactive signals - data, loading, error -
 * plus an imperative refetch(). It is the primitive behind every data-fetching feature
 * in the framework: route loaders, manual resource calls, suspense integration.
 *
 * KEY BEHAVIORS:
 *   - Two forms: standalone (createResource(fetcher)) and source-driven
 *     (createResource(() => key(), fetcher)), the latter re-running when the source
 *     changes and passing the source value to the fetcher.
 *   - Source-falsy skip: if the source returns false/null/undefined the fetcher is not
 *     called and data resets to undefined (the "skip fetching" pattern). 0 and '' are
 *     valid keys, not skip values.
 *   - Cancellation: each fetch gets its own AbortController; a source change, refetch(),
 *     or scope disposal aborts the in-flight one, threading the signal to the fetcher.
 *   - Race guard: a superseded fetch's controller is aborted, and if its promise
 *     resolves anyway the result is dropped (checked via signal.aborted) so a slow old
 *     response can never overwrite newer state.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect } from './create-effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';

/**
 * The reactive shape returned by {@link createResource}.
 *
 * @typeParam T - The fetched value type.
 */
export interface Resource<T>
{
    /** Most recently resolved value, or undefined (initial, source-falsy, or errored before a value). Reading it inside an effect subscribes, like any getter. */
    data: Getter<T | undefined>;

    /** Whether a fetch is in flight: true synchronously after construction and after each source change / refetch(); false once the fetcher settles. */
    loading: Getter<boolean>;

    /** Error from the most recent failed fetch, or null on success/none. Cleared at the start of every fetch. */
    error: Getter<unknown>;

    /** Re-runs the fetcher with the current source value, aborting any in-flight fetch first; a no-op while the source is falsy. */
    refetch: () => void;
}

/** Fetcher form with no source signal. @typeParam T - fetched value type. */
type StandaloneFetcher<T> = (signal: AbortSignal) => Promise<T>;

/** Fetcher form with a source signal. @typeParam S - source type. @typeParam T - fetched value type. */
type SourceFetcher<S, T> = (sourceValue: S, signal: AbortSignal) => Promise<T>;

/**
 * createResource
 *
 * PURPOSE:
 * Wraps an async fetcher into a reactive {@link Resource} (data/loading/error +
 * refetch). The standalone form loads once; the source form re-runs automatically when
 * its source signal changes.
 *
 * WHY IT EXISTS:
 * Correct async data needs more than a promise: synchronized loading/error/data state,
 * a fresh AbortController per request, cancellation on supersession/unmount, and a guard
 * so a slow old response cannot overwrite a newer one. Hand-wiring that at each call
 * site is verbose and a frequent source of stale-result and leak bugs.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. The data-layer primitive under route loaders and suspense.
 * Must run inside a createRoot (a component or render() provides one) so the internal
 * effect and any in-flight abort are cleaned up on unmount.
 *
 * INPUT CONTRACT:
 * - Standalone: createResource(fetcher), fetcher: (signal) => Promise<T>.
 * - Source: createResource(source, fetcher), source: () => key|false|null|undefined,
 *   fetcher: (key, signal) => Promise<T>. A falsy source skips the fetch.
 *
 * OUTPUT CONTRACT:
 * - Returns a {@link Resource}: data() (T | undefined), loading() (boolean), error()
 *   (unknown | null), refetch(). All are reactive getters.
 *
 * WHY THIS DESIGN:
 * The fetch lives in an effect that reads the source and an internal `tick` signal, so
 * both a source change AND refetch() drive it through the same path; the effect's
 * onCleanup aborts the previous controller before the next fetch starts, and the
 * signal.aborted check on resolve discards superseded results. Synchronous "before"
 * updates are batched so subscribers never see loading=true with a stale error.
 *
 * WHEN TO USE:
 * For any async read that needs loading/error state and cancellation: API calls, route
 * loaders, derived fetches keyed by a signal.
 *
 * WHEN NOT TO USE:
 * For synchronous derivations (use createMemo). For fire-and-forget mutations with no
 * reactive state to track.
 *
 * EDGE CASES:
 * - Source returning false/null/undefined skips the fetch and resets data to undefined;
 *   0 and '' are valid keys.
 * - refetch() while the source is falsy is a no-op (nothing meaningful to refetch).
 * - A superseded fetch that resolves after being aborted is dropped, not applied.
 *
 * PERFORMANCE NOTES:
 * One effect plus three signals; one live AbortController per in-flight fetch. Rapid
 * source changes abort earlier requests rather than letting them all settle.
 *
 * DEVELOPER WARNING:
 * Must be created inside a root/component scope, or the internal effect and a pending
 * fetch will not be cleaned up on unmount. The fetcher should honor the AbortSignal it
 * receives, or cancellation only drops the result without stopping the network work.
 *
 * @typeParam T - The fetched value type.
 * @typeParam S - The source value type (source form).
 * @param sourceOrFetcher - The fetcher (standalone) or the source getter (source form).
 * @param maybeFetcher - The fetcher, when a source getter was passed first.
 * @returns A reactive {@link Resource}.
 * @see {@link createSignal}
 * @see {@link createEffect}
 * @example
 * const post = createResource(
 *     () => postId(),
 *     async (id, signal) => (await fetch(`/api/posts/${ id }`, { signal })).json()
 * );
 * post.loading(); post.data(); post.refetch();
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
    // Discriminate the overloads by whether a second argument was supplied.
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

    // Internal: refetch() bumps `tick` to force the wrapper effect to re-run with the
    // same source value. Never exposed.
    const [tick, setTick] = createSignal(0);

    // The three values meaning "no key, don't fetch". 0 and '' are valid keys.
    function isSkipValue(v: unknown): boolean
    {
        return v === null || v === undefined || v === false;
    }

    // Start a fetch under `controller`: loading flips true synchronously; data/error are
    // settled by the promise (superseded results dropped via signal.aborted).
    function startFetch(controller: AbortController, sourceValue: S | undefined): void
    {
        // Batch the synchronous "before" updates so subscribers never see loading=true
        // with the previous error still set.
        batch(() =>
        {
            setLoading(true);
            setError(null);
        });

        // Invoke the fetcher SYNCHRONOUSLY (so a fetcher that registers an abort listener does so before a
        // superseding navigation can abort it), but guard the call: a fetcher that throws synchronously -
        // or returns a non-promise - is normalized into the same settle path below, instead of escaping
        // startFetch with loading stuck true forever. `Promise.resolve(value)` wraps a sync return; the
        // try/catch converts a sync throw into a rejected chain.
        let pending: Promise<T>;
        try
        {
            pending = Promise.resolve(hasSource
                ? (fetcher as SourceFetcher<S, T>)(sourceValue as S, controller.signal)
                : (fetcher as StandaloneFetcher<T>)(controller.signal));
        }
        catch (error)
        {
            pending = Promise.reject(error);
        }

        pending.then(
            (result) =>
            {
                // May resolve AFTER a newer fetch aborted us - drop superseded results.
                if (controller.signal.aborted)
                {
                    return;
                }

                batch(() =>
                {
                    // Wrapper-arrow form so `result` is stored verbatim even if it is a function.
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

    // The reactive heart: reads `tick` and `source`; on either change the previous run's
    // onCleanup aborts the in-flight fetch, then this body starts the new one.
    createEffect(() =>
    {
        tick(); // subscribe so refetch() can force a re-run

        let sourceValue: S | undefined;
        if (source !== null)
        {
            const v = source();
            if (isSkipValue(v))
            {
                // No key, no fetch. Reset to "nothing loaded"; anything in flight was
                // aborted by the cleanup that fired before us.
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

        // Aborting on the next re-run (or root dispose) is the cancellation guarantee.
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
