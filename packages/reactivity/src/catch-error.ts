// catchError routes errors thrown inside a reactive scope to a user handler
// instead of letting them propagate to the page. It powers `<ErrorBoundary>`
// in @azerothjs/component and is exposed on its own for custom error handling
// at the reactive layer.
//
// What gets caught:
//   - A synchronous throw inside `fn`.
//   - Throws inside any effect created within `fn`'s scope, on its initial run
//     and every later re-run.
//   - Throws inside any memo's compute (memos are effects).
// The effect/memo case works because effects capture the ambient
// currentErrorHandler at construction time and store it on the subscriber, so
// a re-run triggered long after the scope returned still routes to the handler
// that was active when the effect was created.
//
// What does not get caught:
//   - Promise rejections in async fetchers - already observable as
//     Resource.error(); routing them here would double-report the failure.
//   - Errors in event handlers (onClick, etc.) - those run in browser-driven
//     scope, not inside a reactive scope.
//   - Errors entirely outside any catchError call - they propagate normally.
//
// Nesting: catchError calls compose. The inner handler catches first; the
// outer one sees only errors the inner declined (re-threw). So the closest
// enclosing handler wins.

/**
 * The handler registered by the most recent `catchError` call,
 * or `null` if no handler is active.
 *
 * Effects read this at CONSTRUCTION TIME (not at run time) and
 * store the value on their subscriber, so a handler installed
 * before the effect was created keeps catching even after the
 * `catchError` scope returns.
 *
 * @internal Managed by catchError, read by createEffect
 */
export let currentErrorHandler: ((error: unknown) => void) | null = null;

/**
 * Sets the current error handler. Used internally by
 * `catchError` to install/restore the handler around its body.
 *
 * @param handler - The handler to install, or null to clear
 *
 * @internal
 */
export function setCurrentErrorHandler(
    handler: ((error: unknown) => void) | null
): void
{
    currentErrorHandler = handler;
}

/**
 * Runs `fn` with `handler` installed as the active error
 * handler for the duration of the call. Errors thrown
 * synchronously by `fn`, and errors thrown by any effect or
 * memo created during `fn`, are routed to `handler` instead of
 * propagating.
 *
 * Returns `fn`'s return value when no error occurred, or `undefined` (cast to
 * `T`) when an error was caught - the handler ran, but there is no meaningful
 * value to give back.
 *
 * Most users should reach for `<ErrorBoundary>` first; this primitive is for
 * cases where the boundary doesn't fit (custom logging, retry-with-backoff).
 *
 * @typeParam T - The return type of `fn`
 *
 * @param fn - The function to run under the error handler
 * @param handler - Called with any caught error
 *
 * @returns `fn`'s return value, or `undefined` when an error was caught
 *
 * Why: a try/catch only sees synchronous throws, not the ones an effect throws
 * later when a signal change re-runs it.
 *
 * Without catchError: a plain try/catch misses deferred effect throws:
 *
 *     try
 *     {
 *         createEffect(() => render(lookup(userId())));
 *     }
 *     catch (err) { handle(err); } // never fires when userId() changes later
 *
 * With catchError: throws from effects in the scope route to the handler too:
 *
 *     catchError(
 *         () => createEffect(() => render(lookup(userId()))),
 *         (err) => handle(err) // catches the initial run and every re-run
 *     );
 *
 * @example
 * ```ts
 * // Catch a synchronous setup error
 * const result = catchError(
 *     () => parseUserConfig(rawJson),
 *     (err) => console.error('Bad config:', err)
 * );
 * ```
 *
 * @example
 * ```ts
 * // Catch errors from effects created inside the scope. The effect re-runs
 * // on signal changes, and every re-run routes its errors to the same handler.
 * catchError(
 *     () =>
 *     {
 *         createEffect(() =>
 *         {
 *             const user = lookup(userId()); // throws on a missing record
 *             render(user);
 *         });
 *     },
 *     (err) => showToast(`Failed: ${ String(err) }`)
 * );
 * ```
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
        // Synchronous error during fn(). Route it through the same handler -
        // the contract is "errors don't escape this call", which includes the
        // function's own throws.
        handler(err);

        // fn failed, so there is no return value. Cast undefined to T to keep
        // the caller's signature clean; callers learn whether the handler
        // fired from the handler itself, not from the return.
        return undefined as unknown as T;
    }
    finally
    {
        // Restore the previous handler so nested catchError calls unwind
        // correctly, popping back to the outer handler.
        setCurrentErrorHandler(previous);
    }
}
