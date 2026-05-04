// ============================================================================
// AZEROTHJS — catchError (Reactive Error Boundary Primitive)
// ============================================================================
//
// Routes errors thrown inside a reactive scope to a user handler
// instead of letting them propagate up to the page. Powers the
// `<ErrorBoundary>` component in @azerothjs/component, and is
// available on its own for power users who want to instrument
// custom error-handling at the reactive layer.
//
// WHAT GETS CAUGHT:
//
//   - Synchronous throw inside `fn` itself
//   - Throws inside any effect created within `fn`'s scope, on
//     the effect's INITIAL run AND on every subsequent re-run
//   - Throws inside any memo's compute (memos are effects)
//
//   The effect/memo case works because effects capture the
//   ambient `currentErrorHandler` at construction time and store
//   it on the subscriber. When the effect re-runs months later
//   in response to a signal change, it still routes errors to
//   the handler that was active when it was created.
//
// WHAT DOES NOT GET CAUGHT:
//
//   - Promise rejections in async fetchers — those are already
//     observable as `Resource.error()`. Routing them through here
//     would create two reporting paths for the same failure.
//   - Errors in event handlers (onClick, etc.) — the handler runs
//     in browser-driven scope, not inside any reactive scope.
//   - Errors that happen entirely outside a `catchError` call —
//     they propagate normally, just as they did before.
//
// NESTING:
//
//   `catchError` calls compose: an inner handler catches first;
//   the outer handler only sees errors that the inner declined
//   to handle (i.e., that re-threw). For most uses this means
//   the closest enclosing handler wins, which is what users
//   expect.
//
// ============================================================================

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
 * Returns `fn`'s return value when no error occurred. Returns
 * `undefined` (cast to `T`) when an error was caught — the
 * handler ran, but there is no meaningful value to give back.
 *
 * Most users should reach for `<ErrorBoundary>` first; this
 * primitive is for cases where the boundary doesn't fit (custom
 * logging, retry-with-backoff, etc.).
 *
 * @typeParam T - The return type of `fn`
 *
 * @param fn - The function to run under the error handler
 * @param handler - Called with any caught error
 *
 * @returns `fn`'s return value, or `undefined` when an error
 *          was caught
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
 * // Catch errors from effects created inside the scope.
 * // The effect re-runs on signal changes — every re-run
 * // routes its errors to the same handler.
 * catchError(
 *     () =>
 *     {
 *         createEffect(() =>
 *         {
 *             // …throws if userId() points at a missing record:
 *             const user = lookup(userId());
 *             render(user);
 *         });
 *     },
 *     (err) => showToast(`Failed: ${ String(err) }`)
 * );
 * ```
 *
 * @example
 * ```ts
 * // Nested handlers — inner wins.
 * catchError(
 *     () =>
 *     {
 *         catchError(
 *             () => somethingThatThrows(),
 *             (err) => log('inner', err)
 *         );
 *     },
 *     (err) => log('outer', err) // only fires if inner re-throws
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
        // Synchronous error during fn(). Route through the same
        // handler — the contract is "errors don't escape this
        // call" and that includes the function's own throws.
        handler(err);

        // The function failed, so its return value is undefined
        // by definition. Cast to T so the caller's type sig stays
        // clean; callers handle "did the handler fire?" via the
        // handler itself, not by inspecting the return.
        return undefined as unknown as T;
    }
    finally
    {
        // Restore the previous handler exactly. Nested
        // `catchError` calls rely on this for correct unwinding —
        // popping back to the outer handler when an inner scope
        // returns.
        setCurrentErrorHandler(previous);
    }
}
