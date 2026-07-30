/**
 * MODULE: http/request-root - a request is a reactive root
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
import { setStoreScopeResolver } from 'azerothjs/internal';
import { PayloadResponse } from './payload.ts';

/** What the async context carries for one request. @internal */
interface RequestScope
{
    storeScope: object;
    /** Lazily allocated on the first onRequestCleanup - most requests register none. */
    cleanups: Array<() => void | Promise<void>> | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

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
    (scope.cleanups ??= []).push(fn);
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
async function runCleanups(scope: RequestScope, options: RootOptions): Promise<void>
{
    const cleanups = scope.cleanups;
    if (cleanups === null)
    {
        return;
    }
    scope.cleanups = null;
    for (let i = cleanups.length - 1; i >= 0; i--)
    {
        try
        {
            await cleanups[i]?.();
        }
        catch (error)
        {
            options.onCleanupError?.(error);
        }
    }
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
    const monitored = new ReadableStream<Uint8Array>({
        async pull(controller)
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
        },
        async cancel(reason)
        {
            await reader.cancel(reason);
            await runCleanups(scope, options);
        }
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
    installResolver();
    // `arg` rides through storage.run instead of a per-request closure over `fn`;
    // the caller passes ONE stable function for the app's lifetime.
    const scope: RequestScope = { storeScope: {}, cleanups: null };
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
    // they run at its true end. Only pays the wrap when a cleanup was actually registered -
    // the hot path (no cleanups) returns the result untouched.
    if (scope.cleanups !== null && isStreamingResponse(result))
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
                void runCleanups(scope, options);
            }, { once: true });
        }
        return deferCleanupsToBody(result, scope, options) as T;
    }

    await runCleanups(scope, options);
    return result;
}
