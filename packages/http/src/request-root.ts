/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A request is a reactive root.
 *
 * Runs each request inside an AsyncLocalStorage context carrying two things:
 *
 *   - a fresh STORE SCOPE. `createStore` singletons key on the active scope, so two
 *     concurrent requests get isolated instances - the exact isolation SSR renders already
 *     have, extended across `await` (reactivity's synchronous runInStoreScope cannot survive
 *     one; this module installs the async-context resolver reactivity exposes for hosts).
 *   - a CLEANUP REGISTRY. `onRequestCleanup(fn)` registers teardown that ALWAYS runs when
 *     the request settles - success, throw, or client abort - in LIFO order, mirroring the
 *     component world's onCleanup. (Reactivity's own onCleanup is a silent no-op outside a
 *     synchronous root, which an async handler is not; this registry is the request-scoped
 *     equivalent that survives awaits.)
 *
 * The resolver returns undefined outside a request, falling through to the synchronous
 * scope - so an SSR render nested INSIDE a request still isolates via its own
 * runInStoreScope, and non-request code (startup, tests without the root) behaves exactly
 * as before.
 *
 * AsyncLocalStorage is Node's async-context primitive; Bun, Deno, and workerd implement it
 * too, so this module - the one non-fetch-standard dependency of the app model - runs on
 * every mainstream server runtime. When TC39 AsyncContext lands, only this file changes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { abortDataCacheFetches, markServerRuntime, releaseDataCache, setStoreScopeResolver } from 'azerothjs/internal';
import { PayloadResponse } from './payload.ts';

/** What the async context carries for one request. @internal */
interface RequestScope
{
    storeScope: object;
    /** Lazily allocated on the first onRequestCleanup - most requests register none. */
    cleanups: Array<() => void | Promise<void>> | null;
    /** True once teardown has finished: a later registration runs instead of queueing. */
    settled: boolean;
    /** How a throwing cleanup is reported, reachable from every settle path. */
    options: RootOptions;

    /**
     * The one in-flight teardown, memoized so concurrent settle paths (the abort listener
     * racing stream end) share it instead of re-entering: a second entrant would take the
     * no-cleanups early return and release the cache WHILE the first entrant's cleanup
     * rounds still run, handing their reads a dead cache mid-teardown.
     */
    teardown: Promise<void> | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** Teardown rounds a request may register from inside its own cleanups before we stop. */
const MAX_CLEANUP_ROUNDS = 8;

/**
 * Captures the ambient async context; the returned function re-enters it around a call.
 * Re-entry restores the ENTIRE capture-time frame - an ambient context present at call
 * time but not at capture is replaced for the call's duration - which outside a request
 * root means restoring the empty frame. Lives here so this file stays the kernel's ONE
 * `node:async_hooks` seam.
 *
 * @internal
 */
export function captureRequestContext(): <R>(fn: () => R) => R
{
    return AsyncLocalStorage.snapshot();
}

let resolverInstalled = false;

/** @internal Idempotent: reactivity consults the async context once a server exists. */
function installResolver(): void
{
    if (!resolverInstalled)
    {
        resolverInstalled = true;
        setStoreScopeResolver(() => storage.getStore()?.storeScope);
    }
}

/**
 * Registers teardown for the CURRENT request: closing a transaction, releasing a lock,
 * returning a connection. Runs when the request settles - success, error, or disconnect -
 * in LIFO order (later acquisitions release first). Throws outside a request: teardown
 * registered nowhere is a leak wearing a seatbelt, and loud beats leaking.
 */
export function onRequestCleanup(fn: () => void | Promise<void>): void
{
    const scope = storage.getStore();
    if (scope === undefined)
    {
        throw new Error('onRequestCleanup was called outside a request. It registers teardown '
            + 'for the current request root, so it only makes sense inside a handler or middleware.');
    }
    if (scope.settled)
    {
        // The request already tore down - a client that aborted before the producer got its
        // connection, or a body the kernel could not monitor. Queueing here would push onto a
        // list nothing drains, so the registration runs NOW: teardown always runs, and a
        // release that arrives late is still a release.
        void runLate(fn, scope);
        return;
    }
    (scope.cleanups ??= []).push(fn);
}

/** @internal Runs one late teardown inside its request's context, reporting its failure. */
async function runLate(fn: () => void | Promise<void>, scope: RequestScope): Promise<void>
{
    await storage.run(scope, async () =>
    {
        try
        {
            await fn();
        }
        catch (error)
        {
            try
            {
                scope.options.onCleanupError?.(error);
            }
            catch
            {
                // The error sink is the last stop; its own failure has nowhere to go.
            }
        }
    });
}

/** @internal Options threaded from the App: how a throwing cleanup is reported. */
interface RootOptions
{
    onCleanupError?: ((error: unknown) => void) | undefined;
}

/**
 * Runs a scope's cleanups in LIFO order (later acquisitions release first), each awaited and
 * each isolated - a throwing cleanup is reported and the rest still run, so teardown never
 * clobbers the response or a sibling's release. Idempotent via the null-out: called at most
 * once per scope whichever settle path (throw, buffered return, stream end) reaches it first.
 *
 * @internal
 */
function runCleanups(scope: RequestScope, options: RootOptions): Promise<void>
{
    scope.teardown ??= teardownOnce(scope, options);
    return scope.teardown;
}

/** @internal The single teardown body behind {@link runCleanups}' memoization. */
async function teardownOnce(scope: RequestScope, options: RootOptions): Promise<void>
{
    // The request's data cache dies with its scope; aborting its outstanding fetches here
    // keeps their settle closures from outliving the request that started them. Before the
    // early return: fetches can be in flight even when no user cleanup was registered.
    abortDataCacheFetches(scope.storeScope);
    if (scope.cleanups === null)
    {
        // Nothing registered YET, but the request has reached a settle point: anything
        // registered from here on runs immediately rather than queueing (onRequestCleanup).
        scope.settled = true;
        releaseDataCache(scope.storeScope);
        return;
    }
    // Re-enter the request's async context: every settle path (the post-await continuation,
    // stream end, cancel, abort) arrives here OUTSIDE it - storage.run restores the outer
    // context the moment fn returns its promise - and a cleanup, or the error observer for
    // one that throws, resolving a request-scoped store must get THIS request's instance,
    // not the process-wide default.
    await storage.run(scope, async () =>
    {
        // Drained to exhaustion: a cleanup registering another (a release that queues the
        // pool return) is legal INSIDE the root, and the batch it registers must run rather
        // than land on a list nothing reads. Bounded, so a cleanup that re-registers itself
        // reports instead of spinning.
        for (let round = 0; scope.cleanups !== null; round++)
        {
            const batch = scope.cleanups;
            scope.cleanups = null;
            if (round >= MAX_CLEANUP_ROUNDS)
            {
                try
                {
                    options.onCleanupError?.(new Error('onRequestCleanup kept registering new teardown from '
                        + `inside a cleanup after ${ MAX_CLEANUP_ROUNDS } rounds; the remaining ${ batch.length } `
                        + 'were dropped to end the request.'));
                }
                catch
                {
                    // A throwing sink must not reject teardown: that would skip both the
                    // settled flag and the release below.
                }
                return;
            }
            for (let i = batch.length - 1; i >= 0; i--)
            {
                try
                {
                    await batch[i]?.();
                }
                catch (error)
                {
                    try
                    {
                        options.onCleanupError?.(error);
                    }
                    catch
                    {
                        // The error sink is the last stop: its own failure cannot be reported
                        // anywhere, and must not reject teardown or strand the response.
                    }
                }
            }
        }
    });
    scope.settled = true;
    // The LAST act, after every cleanup round: cleanups legitimately read the settled
    // entries (and may fetch fresh keys) during teardown - releasing any earlier would
    // hand them a dead cache, and releasing here sweeps whatever they repopulated.
    releaseDataCache(scope.storeScope);
}

/**
 * Whether a handler's result is a LIVE streaming response whose body is still being produced
 * after the handler returned - an SSE feed, a piped file, a multipart stream, or any handler
 * that returned `new Response(readableStream)`. The kernel's buffered responses are a
 * {@link PayloadResponse} (brand-linked to Response.prototype, so `instanceof Response` is
 * true for them); they are excluded FIRST, before the `.body` check, because reading their
 * lazy `.body` getter would needlessly materialize their bytes. Only a genuine web `Response`
 * carrying a ReadableStream body reaches the deferral path.
 *
 * @internal
 */
function isStreamingResponse(result: unknown): result is Response & { body: ReadableStream<Uint8Array> }
{
    return result instanceof Response
        && !(result instanceof PayloadResponse)
        && result.body instanceof ReadableStream;
}

/**
 * Wraps a streaming response's body so the request's cleanups run when the STREAM settles -
 * normal close, producer error, or consumer cancel (client disconnect) - not when the handler
 * returned. The wrapper pulls on demand (backpressure preserved: the adapter reads a chunk,
 * the wrapper reads one from the source), so a slow client still throttles the producer. The
 * body is the one object whose completion means "response fully produced," and it flows to
 * every adapter identically, so this is runtime-agnostic.
 *
 * @internal
 */
function deferCleanupsToBody(response: Response & { body: ReadableStream<Uint8Array> }, scope: RequestScope, options: RootOptions): Response
{
    const reader = response.body.getReader();
    // Each pull/cancel re-enters the request context EXPLICITLY and unconditionally: a
    // pull's async context is whoever dispatched it (the adapter, the consumer's pace) -
    // a Node implementation detail, not a spec guarantee - so a synchronous producer's
    // continuations would otherwise resolve the DEFAULT scope from pull #2 on. A pull
    // arriving after the abort path already released re-enters harmlessly: reads land on
    // the cache's silent released path, and request-scoped state keeps its instance.
    const monitored = new ReadableStream<Uint8Array>({
        pull: (controller) => storage.run(scope, async () =>
        {
            try
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    controller.close();
                    await runCleanups(scope, options);
                    return;
                }
                controller.enqueue(value);
            }
            catch (error)
            {
                controller.error(error);
                await runCleanups(scope, options);
            }
        }),
        cancel: (reason) => storage.run(scope, async () =>
        {
            await reader.cancel(reason);
            await runCleanups(scope, options);
        })
    });

    return new Response(monitored, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

/**
 * Runs `fn` inside a fresh request root. The App wraps every dispatch in this; adapters and
 * user code never call it directly. Cleanups ALWAYS run when the request settles: a throw or a
 * buffered response runs them immediately; a STREAMING response (SSE, static file, multipart,
 * any `new Response(stream)`) defers them to the body's end, so teardown that releases a pooled
 * connection/transaction/lock cannot fire while the stream is still pulling through it.
 */
export async function runInRequestRoot<T, A>(
    fn: (arg: A) => T | Promise<T>,
    arg: A,
    options: RootOptions = {}
): Promise<T>
{
    markServerRuntime();
    installResolver();
    // `arg` rides through storage.run instead of a per-request closure over `fn`;
    // the caller passes ONE stable function for the app's lifetime.
    const scope: RequestScope = { storeScope: {}, cleanups: null, settled: false, options, teardown: null };
    let result: T;
    try
    {
        result = await storage.run(scope, fn, arg);
    }
    catch (error)
    {
        await runCleanups(scope, options);
        throw error;
    }

    // A live streaming body outlives the handler return: hand the cleanups to the stream so
    // they run at its true end. The wrap cannot be gated on a cleanup being registered YET -
    // a producer that awaits real I/O registers its teardown after this continuation has
    // already run - so every streaming response pays it; buffered responses settle below.
    if (isStreamingResponse(result))
    {
        // The stream is the PRIMARY settle signal, but it is not the only one: an adapter that
        // finds the socket already destroyed has nothing to read the body with, so nothing would
        // ever pull or cancel it and the cleanups would never run. An abort therefore also
        // settles the root. `runCleanups` nulls the list before awaiting, so whichever signal
        // arrives first wins and the other is a no-op.
        const signal = arg instanceof Request ? arg.signal : undefined;
        if (signal !== undefined)
        {
            if (signal.aborted)
            {
                await runCleanups(scope, options);
                return result;
            }
            signal.addEventListener('abort', () =>
            {
                // Nothing awaits this settle path, so its rejection has nowhere to land and
                // would surface as an unhandled rejection - fatal under Node's default.
                void runCleanups(scope, options).catch(() => undefined);
            }, { once: true });
        }
        try
        {
            return deferCleanupsToBody(result, scope, options) as T;
        }
        catch
        {
            // A body the kernel cannot monitor (the handler took its own reader, so the
            // stream is locked) still has to settle the root: run the cleanups now and send
            // the original response rather than leaking the request and answering a 500.
            await runCleanups(scope, options);
            return result;
        }
    }

    await runCleanups(scope, options);
    return result;
}
