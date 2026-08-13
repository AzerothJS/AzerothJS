/**
 * Routing reactive errors to a handler instead of the page. This is the primitive under
 * <ErrorBoundary>, exposed directly for error handling at the reactive layer.
 *
 * Caught: a synchronous throw inside the guarded function; a throw inside any effect
 * created in its scope, on the first run and every later re-run; a throw inside any memo's
 * compute. The deferred cases work because an effect captures the ambient handler at
 * CONSTRUCTION and stores it on the subscriber, so a re-run long after the scope returned
 * still routes to the handler that was active when the effect was created.
 *
 * Not caught: promise rejections from async fetchers, which are observable as
 * Resource.error() and would otherwise double-report; errors in DOM event handlers, which
 * run in browser-driven scope; and anything thrown outside every catchError call.
 *
 * Handlers nest. The innermost catches first, and an outer one sees only what the inner
 * rethrew.
 */

/**
 * The handler from the most recent catchError, or null. Effects read it at CONSTRUCTION and
 * store it on their subscriber, which is what keeps it catching after the scope returns.
 *
 * @internal Managed by catchError, read by createEffect and createMemo.
 */
export let currentErrorHandler: ((error: unknown) => void) | null = null;

/**
 * Installs or clears the current error handler and returns the previous one, so callers can
 * restore it around a body.
 *
 * @internal
 */
export function setCurrentErrorHandler(
    handler: ((error: unknown) => void) | null
): ((error: unknown) => void) | null
{
    const previous = currentErrorHandler;
    currentErrorHandler = handler;
    return previous;
}

/** Where an uncaught reactive error escaped from. */
export interface UncaughtErrorContext
{
    /** The kind of node whose run threw. */
    source: 'effect' | 'memo';

    /** The node's debug name from `{ name }`, if it was given one. */
    name?: string | undefined;
}

/**
 * The last-resort handler, consulted at THROW time rather than captured at creation. Null
 * means uncaught errors propagate.
 *
 * @internal Read by the effect and memo catch blocks.
 */
export let uncaughtErrorHandler: ((error: unknown, context: UncaughtErrorContext) => void) | null = null;

/**
 * Registers the global last-resort handler for reactive errors no catchError scope claimed
 * - typically logging or telemetry, installed once at startup.
 *
 * Unlike catchError, this is consulted at THROW time rather than captured at effect
 * creation, so one registration covers effects created both before and after it.
 *
 * There is a single global slot. A second registration shadows the first until its
 * unregister runs, and unregistering restores the previous handler, so nested installs
 * unwind correctly. A scoped catchError always wins over this.
 *
 * @param handler - Receives the error and where it escaped from.
 * @returns An unregister function restoring the previously registered handler.
 * @example
 * const uninstall = onUncaughtError((error, context) =>
 * {
 *     report(`uncaught in ${ context.source } ${ context.name ?? '' }`, error);
 * });
 *
 * @see {@link catchError} for scoped recovery.
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
 * Runs `fn` with `handler` installed as the active reactive error handler. A synchronous
 * throw in `fn`, and any throw from an effect or memo created inside it - on the first run
 * or on a re-run long after `fn` returned - routes to `handler` instead of propagating.
 *
 * That deferred reach is the point: a plain try/catch only sees synchronous throws, while
 * reactive failures usually happen later, when a signal change re-runs an effect long after
 * the setup call returned.
 *
 * Only nodes created DURING `fn` capture the handler. One created earlier and merely re-run
 * inside `fn` still routes to whatever handler was ambient when IT was created.
 *
 * @typeParam T - `fn`'s return type.
 * @param fn - The scope to guard.
 * @param handler - Receives any caught error. Rethrowing from it propagates to the next
 *                  enclosing catchError.
 * @returns `fn`'s return value, or `undefined` when a synchronous error was caught - the
 *          handler has already run by then, so there is no value to return.
 * @example
 * catchError(
 *     () => createEffect(() => render(lookup(userId()))),
 *     (error) => showToast(`Failed: ${ String(error) }`) // catches the first run and every re-run
 * );
 *
 * @see {@link onUncaughtError} for the global fallback.
 */
export function catchError<T>(
    fn: () => T,
    handler: (error: unknown) => void
): T | undefined
{
    const previous = currentErrorHandler;
    setCurrentErrorHandler(handler);

    try
    {
        return fn();
    }
    catch (err)
    {
        // The contract is "errors do not escape this call", which includes fn's own throws.
        handler(err);
        return undefined;
    }
    finally
    {
        // Restore so nested catchError calls unwind to the outer handler.
        setCurrentErrorHandler(previous);
    }
}
