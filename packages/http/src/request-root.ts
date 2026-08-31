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
 *   - a CLEANUP REGISTRY. `onWorkUnitCleanup(fn)` registers teardown that ALWAYS runs when
 *     the unit settles - success, throw, or client abort - in LIFO order, mirroring the
 *     component world's onCleanup. (Reactivity's own onCleanup is a silent no-op outside a
 *     synchronous root, which an async handler is not; this registry is the unit-scoped
 *     equivalent that survives awaits.)
 *
 * A request is ONE KIND of work unit. `runInWorkUnit` is the bare unit root (scope +
 * cleanups + release at settle); the request root is that plus the HTTP settle policy
 * (streaming deferral, abort-as-settle); `createWorkUnitInterceptor` packages the unit
 * root in the constructor-supplied shape ws and cron accept.
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
import { isClientFault, reportIsolated } from './errors.ts';

/** What the async context carries for one request. @internal */
interface RequestScope
{
    storeScope: object;
    /** Lazily allocated on the first onWorkUnitCleanup - most requests register none. */
    cleanups: Array<() => void | Promise<void>> | null;
    /** True once teardown has finished: a later registration runs instead of queueing. */
    settled: boolean;
    /** How a throwing cleanup is reported, reachable from every settle path. */
    options: WorkUnitOptions;

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

/**
 * The ONE resolver http registers, hoisted to module scope: reactivity's slot is
 * single-writer with same-function idempotence, so re-installing after a consumer's
 * uninstall (a test harness's afterEach) works only because every install passes this
 * exact function - a per-call arrow would trip the foreign-registrant refusal.
 */
const resolveUnitScope = (): object | undefined => storage.getStore()?.storeScope;

/** @internal Idempotent: reactivity consults the async context once a server exists. */
function installResolver(): void
{
    setStoreScopeResolver(resolveUnitScope);
}

/**
 * Registers teardown for the CURRENT work unit: closing a transaction, releasing a lock,
 * returning a connection. Runs when the unit settles - success, error, or disconnect -
 * in LIFO order (later acquisitions release first). Throws outside a unit: teardown
 * registered nowhere is a leak wearing a seatbelt, and loud beats leaking.
 */
export function onWorkUnitCleanup(fn: () => void | Promise<void>): void
{
    const scope = storage.getStore();
    if (scope === undefined)
    {
        throw new Error('onWorkUnitCleanup was called outside a work unit. It registers teardown '
            + 'for the current unit (an HTTP request root, runInWorkUnit, or an intercepted ws '
            + 'message or cron run), so it only makes sense inside one.');
    }
    if (scope.settled)
    {
        // The unit already tore down - a client that aborted before the producer got its
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
                reportIsolated(scope.options.onCleanupError, error);
            }
            catch
            {
                // The error sink is the last stop; its own failure has nowhere to go.
            }
        }
    });
}

/** How a unit's throwing cleanup is reported; threaded from the App for requests. */
export interface WorkUnitOptions
{
    onCleanupError?: ((error: unknown) => void) | undefined;

    /**
     * Bounds how long the unit may take to PRODUCE its result, answering with `answer()` when
     * it does not. Opt-in; absent means no bound, which is the shipped default.
     *
     * `answer` is called only on fire and its value is returned in the unit's place, so the
     * caller decides the wire shape (the App sends a 503). See {@link raceDeadline} for what
     * this deliberately does NOT do to the scope.
     */
    responseDeadline?: { ms: number; answer: (arg: unknown) => unknown } | undefined;

    /**
     * Hears a STREAMING body's producer failing after the response was already committed.
     *
     * Such a failure cannot become a status - the headers left long ago - so without this it
     * reaches nobody: the consumer gets a truncated body and the server records the clean 2xx
     * it already sent. On h2c the truncation is byte-identical to a normal end, so neither side
     * can see it.
     *
     * The second argument is the unit's own `arg`, typed `unknown` on purpose: {@link
     * runInRequestRoot} is generic and public, and is called in-repo with a non-Request arg, so
     * a reporter must narrow rather than assume.
     */
    onStreamError?: ((error: unknown, arg: unknown) => void) | undefined;
}

/**
 * Runs a scope's cleanups in LIFO order (later acquisitions release first), each awaited and
 * each isolated - a throwing cleanup is reported and the rest still run, so teardown never
 * clobbers the response or a sibling's release. Idempotent via the null-out: called at most
 * once per scope whichever settle path (throw, buffered return, stream end) reaches it first.
 *
 * @internal
 */
function runCleanups(scope: RequestScope, options: WorkUnitOptions): Promise<void>
{
    scope.teardown ??= teardownOnce(scope, options);
    return scope.teardown;
}

/** @internal The single teardown body behind {@link runCleanups}' memoization. */
async function teardownOnce(scope: RequestScope, options: WorkUnitOptions): Promise<void>
{
    // The request's data cache dies with its scope; aborting its outstanding fetches here
    // keeps their settle closures from outliving the request that started them. Before the
    // early return: fetches can be in flight even when no user cleanup was registered.
    abortDataCacheFetches(scope.storeScope);
    if (scope.cleanups === null)
    {
        // Nothing registered YET, but the request has reached a settle point: anything
        // registered from here on runs immediately rather than queueing (onWorkUnitCleanup).
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
                    options.onCleanupError?.(new Error('onWorkUnitCleanup kept registering new teardown from '
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
                        reportIsolated(options.onCleanupError, error);
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
function deferCleanupsToBody(response: Response & { body: ReadableStream<Uint8Array> }, scope: RequestScope, options: WorkUnitOptions, arg: unknown): Response
{
    const reader = response.body.getReader();
    // Each pull/cancel re-enters the request context EXPLICITLY and unconditionally: a
    // pull's async context is whoever dispatched it (the adapter, the consumer's pace) -
    // a Node implementation detail, not a spec guarantee - so a synchronous producer's
    // continuations would otherwise resolve the DEFAULT scope from pull #2 on. A pull
    // arriving after the abort path already released re-enters harmlessly: reads land on
    // the cache's silent released path, and request-scoped state keeps its instance.
    // A CANCEL LANDS INSIDE AN IN-FLIGHT PULL, and without this latch the pull settles the
    // request instead of the cancel branch. Cancelling `monitored` runs the cancel algorithm
    // below, whose `reader.cancel` resolves the pending inner read with `done: true`; the
    // pull then resumes and calls `close()` on a controller the consumer already closed, which
    // THROWS into the catch. Two things go wrong there: a kernel TypeError is manufactured out
    // of an ordinary client disconnect, and - the reason this is a correctness bug rather than
    // noise - the catch runs the cleanups IMMEDIATELY, while the source's own `cancel()` is
    // still running. Measured: teardown at 1ms against a source cancel finishing at 201ms. That
    // is exactly what this wrapper exists to prevent, per its own contract above: teardown that
    // releases a pooled connection, transaction, or lock must not fire while the stream is still
    // unwinding through it. The cancel branch owns the settle; a pull that wakes after it has
    // nothing left to do.
    let cancelled = false;
    const monitored = new ReadableStream<Uint8Array>({
        pull: (controller) => storage.run(scope, async () =>
        {
            try
            {
                const { done, value } = await reader.read();
                if (cancelled)
                {
                    // The cancel branch owns the settle and is already awaiting the source's
                    // own teardown. Returning here is also what keeps the catch below clean:
                    // without it, close() on the consumer's already-closed controller throws,
                    // and the catch cannot tell that manufactured TypeError from a real
                    // producer fault.
                    return;
                }
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
                // Reachable only by a GENUINE producer fault: a cancel-driven wake returns
                // above, so this is no longer a mix of real failures and manufactured ones.
                // Reported BEFORE the stream is failed, so a consumer that has already gone
                // does not cost us the only record of it.
                // A fault the client caused is not a server fault, however it arrives: an
                // SSE slow-client drop errors its own stream ON PURPOSE, and reporting that
                // would mislabel policy working correctly.
                if (!isClientFault(error))
                {
                    // reportIsolated, not a try/catch: the guard that used to be here wrapped
                    // the CALL and not the promise, so an `async` sink's rejection escaped it
                    // and exited the process. Measured, with the synchronous throw already
                    // contained by that same guard.
                    reportIsolated(options.onStreamError, error, arg);
                }
                controller.error(error);
                await runCleanups(scope, options);
            }
        }),
        cancel: (reason) => storage.run(scope, async () =>
        {
            // Set BEFORE reader.cancel, which is what resolves the in-flight read.
            cancelled = true;
            try
            {
                await reader.cancel(reason);
            }
            finally
            {
                // A source whose own cancel() REJECTS is ordinary code - a rollback that
                // failed, a pool release that threw - and it must not cost the request its
                // teardown. Without the finally that rejection skipped runCleanups entirely
                // and every onWorkUnitCleanup leaked permanently. The rejection still
                // propagates to whoever cancelled; it just no longer takes the cleanups with
                // it.
                await runCleanups(scope, options);
            }
        })
    });

    return new Response(monitored, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

/** @internal Brands the deadline branch, so no value a handler can return is mistaken for it. */
const TIMED_OUT = Symbol('azeroth.responseDeadline');

/**
 * @internal Races a unit against its response deadline.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, because each one is a bug rather than a nicety:
 *
 * - It does NOT run cleanups and does NOT set `settled`. {@link onWorkUnitCleanup} runs a
 *   registration IMMEDIATELY once a scope is settled - that late path exists for a request
 *   that is genuinely over - so marking a still-running handler settled means the `release()`
 *   it registers after acquiring a connection fires at once, and the handler then keeps using
 *   a connection already back in the pool. A deadline must not manufacture a use-after-release.
 * - It does NOT release the data cache. Releasing resolves an in-flight `cached()` read to
 *   `undefined` rather than letting it fetch, so a unit that continues past its deadline would
 *   compute on missing data - harmless for a GET, silent corruption for a write.
 *
 * So the deadline frees the SOCKET and answers the client, and nothing else. The handler is not
 * cancelled: its memory, its pool slot, and its upstream connection stay held until it settles
 * on its own. The losing promise keeps a continuation that settles the scope at that true end
 * and CANCELS a late streaming body - without it, a handler that returns a stream after the
 * deadline leaves a response nobody will ever pull, so its cleanups would never run at all.
 */
async function raceDeadline<T>(
    scope: RequestScope,
    fn: (arg: never) => unknown,
    arg: unknown,
    deadline: { ms: number; answer: (arg: unknown) => unknown },
    options: WorkUnitOptions
): Promise<{ value: T } | { [TIMED_OUT]: true; answer: T }>
{
    // storage.run is called synchronously here so the unit still opens inside its own scope.
    const running = Promise.resolve(storage.run(scope, fn as (arg: unknown) => T, arg));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fired = new Promise<typeof TIMED_OUT>((resolve) =>
    {
        timer = setTimeout(() => resolve(TIMED_OUT), deadline.ms);
        // An armed timer must not be what keeps a finished process alive.
        (timer as unknown as { unref?: () => void }).unref?.();
    });

    let outcome: T | typeof TIMED_OUT;
    try
    {
        outcome = await Promise.race([running, fired]);
    }
    catch (error)
    {
        clearTimeout(timer);
        await runCleanups(scope, options);
        throw error;
    }
    clearTimeout(timer);

    if (outcome !== TIMED_OUT)
    {
        return { value: outcome };
    }

    void running.then(
        async (late: T): Promise<void> =>
        {
            // The handler finally produced something nobody is waiting for. A streaming body
            // would otherwise sit unread forever, holding whatever its producer holds, so
            // cancel it - that runs the producer's own cancel - and then settle normally.
            if (isStreamingResponse(late))
            {
                try
                {
                    await (late as Response).body?.cancel();
                }
                catch
                {
                    // A body already locked or errored is still a body nobody will read.
                }
            }
            await runCleanups(scope, options);
        },
        async (): Promise<void> =>
        {
            await runCleanups(scope, options);
        }
    ).catch(() => undefined);

    return { [TIMED_OUT]: true, answer: deadline.answer(arg) as T };
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
    options: WorkUnitOptions = {}
): Promise<T>
{
    markServerRuntime();
    installResolver();
    // `arg` rides through storage.run instead of a per-request closure over `fn`;
    // the caller passes ONE stable function for the app's lifetime.
    const scope: RequestScope = { storeScope: {}, cleanups: null, settled: false, options, teardown: null };
    let result: T;
    const deadline = options.responseDeadline;
    if (deadline !== undefined)
    {
        const raced = await raceDeadline<T>(scope, fn, arg, deadline, options);
        if (TIMED_OUT in raced)
        {
            // EARLY RETURN, and the early part is the point: falling through would reach the
            // settle below and tear down a scope whose handler is still running.
            return raced.answer;
        }
        result = raced.value;
    }
    else
    {
        try
        {
            result = await storage.run(scope, fn, arg);
        }
        catch (error)
        {
            await runCleanups(scope, options);
            throw error;
        }
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
            return deferCleanupsToBody(result, scope, options, arg) as T;
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

/** @internal A value the unit handed back that the settle must wait on. */
function isThenable(value: unknown): value is PromiseLike<unknown>
{
    return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Runs `fn` as ONE WORK UNIT: the unit owns a fresh store scope - so its `cached()` reads
 * get a real per-unit cache on a server whose default scope fails closed - and a cleanup
 * registry ({@link onWorkUnitCleanup}), and both die when the unit settles. The HTTP
 * request root is this plus the HTTP settle policy (streaming deferral, abort-as-settle).
 * Wrap the units no interceptor reaches: a ws `onConnection`/`onClose` body, background
 * regeneration, an app-started timer or queue consumer.
 */
export async function runInWorkUnit<T>(fn: () => T | Promise<T>, options: WorkUnitOptions = {}): Promise<T>
{
    markServerRuntime();
    installResolver();
    const scope: RequestScope = { storeScope: {}, cleanups: null, settled: false, options, teardown: null };
    try
    {
        return await storage.run(scope, fn);
    }
    finally
    {
        await runCleanups(scope, options);
    }
}

/**
 * The constructor-supplied seam ws and cron accept: one unit in, the host's contained
 * reporter alongside. Both hosts declare it structurally so their zero-dependency
 * contract holds; a type spec pins mutual assignability.
 */
export type WorkUnitInterceptor = (unit: () => unknown, report: (error: unknown) => void) => unknown;

/**
 * Builds the interceptor a socket server or scheduler wires at construction - one factory
 * call per host, each carrying its own options. Every intercepted unit (one ws
 * application message, one cron run) owns a work-unit scope: per-unit caching, cleanups,
 * release at settle - the fail-closed cost goes away with no cross-identity sharing. The
 * unit runs synchronously inside its scope; a thenable it returns is what the settle
 * waits on, a sync throw reports and settles, and neither ever escapes to the caller.
 *
 * `deadlineMs` (opt-in, NO default) bounds a unit that never settles: on fire the unit's
 * cache scope is RELEASED and a timeout error reports through the host's reporter. The
 * unit itself cannot be cancelled - it continues at the released scope, and its cleanups
 * still run at the eventual settle, reading a released cache rather than settled entries.
 * Set it for untrusted-input-driven units (ws); leave cron's legitimate long runs unbounded.
 *
 * WHAT A READ SEES ACROSS THE RELEASE, which decides whether a continuing unit may write.
 * A read STARTED AFTER the release fetches directly and gets correct data. A read already
 * IN FLIGHT resolves `undefined`: releasing aborts the in-flight fetch and resolves its
 * waiters, and that prompt, total resolution is what keeps teardown bounded - letting those
 * readers re-fetch instead would leave the deadline bounding nothing, which is the one job
 * it has. So a unit that continues past its deadline MUST NOT PERSIST on a value it read
 * across the release; it has already been reported as over deadline, and `undefined` there
 * is indistinguishable from absent data. {@link raceDeadline} declines to release for this
 * exact reason - it has a live client, so it can afford to leave the scope alone.
 */
export function createWorkUnitInterceptor(options: { deadlineMs?: number } = {}): WorkUnitInterceptor
{
    markServerRuntime();
    installResolver();
    const deadlineMs = options.deadlineMs;
    return (unit, report) =>
    {
        // Per unit, not only at factory time: same-function idempotence makes this free,
        // and it self-heals the resolver slot after a consumer's uninstall - the last
        // door the silent-collapse defect could otherwise survive through.
        installResolver();
        const unitOptions: WorkUnitOptions = { onCleanupError: report };
        const scope: RequestScope = { storeScope: {}, cleanups: null, settled: false, options: unitOptions, teardown: null };
        let deadline: ReturnType<typeof setTimeout> | undefined;
        if (deadlineMs !== undefined)
        {
            deadline = setTimeout(() =>
            {
                deadline = undefined;
                report(new Error(`[azeroth] a work unit exceeded its ${ deadlineMs }ms deadline; its cache scope was `
                    + 'released. The unit keeps running at the released scope and its cleanups still run at settle.'));
                releaseDataCache(scope.storeScope);
            }, deadlineMs);
            (deadline as { unref?: () => void }).unref?.();
        }
        const settle = async (): Promise<void> =>
        {
            if (deadline !== undefined)
            {
                clearTimeout(deadline);
                deadline = undefined;
            }
            await runCleanups(scope, unitOptions);
        };
        let outcome: unknown;
        try
        {
            outcome = storage.run(scope, unit);
        }
        catch (error)
        {
            report(error);
            void settle().catch(() => undefined);
            return undefined;
        }
        if (isThenable(outcome))
        {
            return Promise.resolve(outcome).then(
                async (value) =>
                {
                    await settle();
                    return value;
                },
                async (error: unknown) =>
                {
                    report(error);
                    await settle();
                    return undefined;
                });
        }
        void settle().catch(() => undefined);
        return outcome;
    };
}
