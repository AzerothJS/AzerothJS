// untrack() reads signals without subscribing the active effect. Reach for it
// when an effect needs a signal's current value but must not re-run when that
// value changes. Common cases:
//
//   - Reading peripheral state for a side effect (logging, analytics) that
//     should only fire on the "real" dependencies.
//   - Calling a setter from inside an effect without forming a feedback loop.
//
// It works by clearing the current-subscriber slot for the duration of `fn`,
// so any signal getters called inside see no subscriber and register no
// dependency.

import { currentSubscriber, setCurrentSubscriber } from './signal.ts';

/**
 * Runs `fn` with dependency tracking suspended and returns its result. Signals
 * read inside `fn` do not subscribe the active effect. The previous subscriber
 * is restored afterwards, even if `fn` throws.
 *
 * @param fn - Function to run untracked
 *
 * Why: every signal read inside an effect subscribes it, but sometimes you want
 * the current value without re-running when that value later changes.
 *
 * Without untrack: reading the value subscribes the effect to it:
 *
 *     createEffect(() =>
 *     {
 *         save(doc(), user()); // now re-runs whenever user() changes too
 *     });
 *
 * With untrack: the wrapped read is observed but not subscribed:
 *
 *     createEffect(() =>
 *     {
 *         save(doc(), untrack(() => user())); // re-runs only when doc() changes
 *     });
 *
 * @example
 * ```ts
 * createEffect(() =>
 * {
 *     log(count());                       // tracked: re-runs when count changes
 *     untrack(() => sendMetric(user()));  // user changes won't re-run this effect
 * });
 * ```
 */
export function untrack<T>(fn: () => T): T
{
    const previousSubscriber = currentSubscriber;
    setCurrentSubscriber(null);

    try
    {
        return fn();
    }
    finally
    {
        setCurrentSubscriber(previousSubscriber);
    }
}
