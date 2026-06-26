/**
 * MODULE: reactivity/catch-error
 *
 * catchError routes errors thrown inside a reactive scope to a handler instead of
 * letting them propagate to the page. It powers <ErrorBoundary> in @azerothjs/component
 * and is exposed directly for custom error handling at the reactive layer.
 *
 * WHAT IS CAUGHT:
 *   - a synchronous throw inside fn;
 *   - throws inside any effect created within fn's scope, on its first run AND every
 *     later re-run;
 *   - throws inside any memo's compute (memos are consumers too).
 * The deferred-effect case works because effects capture the ambient handler at
 * CONSTRUCTION time and store it on the subscriber, so a re-run long after the scope
 * returned still routes to the handler that was active when the effect was created.
 *
 * WHAT IS NOT CAUGHT:
 *   - promise rejections in async fetchers (observable as Resource.error(); routing
 *     here would double-report);
 *   - errors in DOM event handlers (they run in browser-driven scope, not a reactive
 *     scope);
 *   - errors entirely outside any catchError call (they propagate normally).
 *
 * NESTING: catchError calls compose - the inner handler catches first; the outer sees
 * only what the inner re-threw. The closest enclosing handler wins.
 */

/**
 * The handler from the most recent catchError, or null. Effects read this at
 * CONSTRUCTION time and store it on their subscriber, so it keeps catching after the
 * scope returns.
 *
 * @internal Managed by catchError, read by createEffect/createMemo.
 */
export let currentErrorHandler: ((error: unknown) => void) | null = null;

/**
 * Installs/clears the current error handler; used by catchError to set and restore it
 * around its body.
 *
 * @internal
 * @param handler - The handler to install, or null to clear.
 */
export function setCurrentErrorHandler(
    handler: ((error: unknown) => void) | null
): void
{
    currentErrorHandler = handler;
}

/** Where an uncaught reactive error escaped from. */
export interface UncaughtErrorContext
{
    /** The kind of node whose run threw. */
    source: 'effect' | 'memo';

    /** The effect's debug name (`createEffect(fn, { name })`), if any. */
    name?: string;
}

/**
 * The last-resort handler, consulted at THROW time (unlike catchError handlers, which
 * are captured at effect creation). null means uncaught errors propagate.
 *
 * @internal Read by effect/memo catch blocks.
 */
export let uncaughtErrorHandler: ((error: unknown, context: UncaughtErrorContext) => void) | null = null;

/**
 * onUncaughtError
 *
 * PURPOSE:
 * Registers a single global, last-resort handler for reactive errors that no catchError
 * scope claimed. Returns an unregister function that restores the previous handler.
 *
 * WHY IT EXISTS:
 * Some failures escape every scoped boundary - an effect created outside any catchError
 * throws on a later re-run. Without a global hook such an error would surface inside
 * whatever signal write happened to trigger the re-run, far from its cause. This is the
 * one place to observe those centrally (logging, telemetry, a dev surface).
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity error handling. Consulted at throw time by effect/memo catch
 * blocks when no captured catchError handler exists.
 *
 * INPUT CONTRACT:
 * - handler: receives the error and an {@link UncaughtErrorContext} (source kind + name).
 *
 * OUTPUT CONTRACT:
 * - Returns an unregister function restoring the previously registered handler. There is
 *   one global slot, so registering replaces the prior handler until unregistered.
 *
 * WHY THIS DESIGN:
 * Throw-time consultation (not creation-time capture) is deliberate: a global observer
 * installed once at startup must catch errors from effects created both before and after
 * it - which capture-at-creation could not.
 *
 * WHEN TO USE:
 * For app-wide last-resort reporting of reactive errors.
 *
 * WHEN NOT TO USE:
 * For scoped recovery - use catchError / <ErrorBoundary>, which always win over this.
 *
 * EDGE CASES:
 * - Only one handler is active at a time; the returned unregister restores the previous
 *   one, so nested installs unwind correctly.
 *
 * PERFORMANCE NOTES:
 * O(1) install/restore. No cost on the success path; consulted only when an uncaught
 * reactive error is thrown.
 *
 * DEVELOPER WARNING:
 * It is a single global slot - a second registration shadows the first until unregistered.
 * It does not catch event-handler or async-rejection errors.
 *
 * @param handler - Receives the error and where it escaped from.
 * @returns Unregister function (restores the previously registered handler).
 * @see {@link catchError}
 * @example
 * const uninstall = onUncaughtError((error, ctx) =>
 *     console.error(`uncaught in ${ ctx.source } ${ ctx.name ?? '' }`, error));
 * // later: uninstall();
 */
export function onUncaughtError(
    handler: (error: unknown, context: UncaughtErrorContext) => void
): () => void
{
    const previous = uncaughtErrorHandler;
    uncaughtErrorHandler = handler;
    return (): void =>
    {
        uncaughtErrorHandler = previous;
    };
}

/**
 * catchError
 *
 * PURPOSE:
 * Runs `fn` with `handler` installed as the active reactive error handler. Synchronous
 * throws in fn, and throws from any effect/memo created inside fn (now and on later
 * re-runs), route to handler instead of propagating.
 *
 * WHY IT EXISTS:
 * A try/catch only sees synchronous throws. Reactive failures are mostly DEFERRED - an
 * effect throws later, when a signal change re-runs it, long after the setup call
 * returned. catchError captures the handler at effect-construction time so those
 * deferred throws are still contained.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity error handling; the primitive under <ErrorBoundary>.
 *
 * INPUT CONTRACT:
 * - fn: the scope to guard. Effects/memos it creates capture this handler.
 * - handler: receives any caught error.
 *
 * OUTPUT CONTRACT:
 * - Returns fn's value on success, or undefined (cast to T) when a synchronous error
 *   was caught - the handler ran, so there is no meaningful value. The previous handler
 *   is restored in a finally.
 *
 * WHY THIS DESIGN:
 * Install-around-fn with restore-in-finally makes handlers nest (inner catches first,
 * outer sees re-throws). Capturing on the subscriber at creation is what extends the
 * guard across an effect's whole lifetime, not just its setup call.
 *
 * WHEN TO USE:
 * When <ErrorBoundary> does not fit: custom logging, retry-with-backoff, or guarding a
 * non-component reactive scope.
 *
 * WHEN NOT TO USE:
 * For UI fallback rendering, prefer <ErrorBoundary>. It does not catch event-handler or
 * async-rejection errors.
 *
 * EDGE CASES:
 * - On a caught synchronous error the return is undefined-as-T; learn that the handler
 *   fired from the handler, not the return value.
 * - Errors the inner handler re-throws propagate to the next enclosing catchError.
 *
 * PERFORMANCE NOTES:
 * O(1) install/restore around fn; no per-effect cost beyond storing one handler
 * reference on each subscriber created in scope.
 *
 * DEVELOPER WARNING:
 * Only effects/memos created DURING fn capture the handler; one created earlier and
 * merely re-run inside fn does not. Async work and event handlers are out of scope.
 *
 * @typeParam T - fn's return type.
 * @param fn - The scope to run under the handler.
 * @param handler - Called with any caught error.
 * @returns fn's return value, or undefined when a synchronous error was caught.
 * @see {@link onUncaughtError}
 * @example
 * catchError(
 *     () => createEffect(() => render(lookup(userId()))),
 *     (err) => showToast(`Failed: ${ String(err) }`) // catches initial run and re-runs
 * );
 */
export function catchError<T>(
    fn: () => T,
    handler: (error: unknown) => void
): T
{
    const previous = currentErrorHandler;
    setCurrentErrorHandler(handler);

    try
    {
        return fn();
    }
    catch (err)
    {
        // Synchronous throw during fn(): route it through the same handler - the
        // contract is "errors don't escape this call", which includes fn's own throws.
        handler(err);

        // fn failed, so there is no value; cast undefined to T to keep the signature
        // clean. Callers learn the handler fired from the handler, not the return.
        return undefined as unknown as T;
    }
    finally
    {
        // Restore the previous handler so nested catchError calls unwind to the outer one.
        setCurrentErrorHandler(previous);
    }
}
