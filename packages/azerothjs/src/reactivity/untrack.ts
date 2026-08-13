/**
 * Reading reactive sources without subscribing to them, by clearing the current-subscriber
 * slot for the duration of the call.
 */

import { currentSubscriber, setCurrentSubscriber } from './graph.ts';
import { assertFunction } from './validate.ts';

/**
 * Runs `fn` with dependency tracking suspended: signals and memos read inside it do not
 * subscribe the surrounding effect or memo, so changing them will not re-run it.
 *
 * Only reading is affected. A write inside `fn` notifies other subscribers exactly as it
 * normally would - which is what makes untrack the way to call a setter from inside an
 * effect without the effect re-triggering itself.
 *
 * The boundary is the callback, not the value: everything read inside is untracked, nothing
 * outside is affected, and the previous subscriber is restored even if `fn` throws. Nesting
 * is fine.
 *
 * @typeParam T - `fn`'s return type.
 * @param fn - Runs immediately, with tracking suspended.
 * @returns Whatever `fn` returns.
 * @throws {TypeError} If `fn` is not a function.
 * @example
 * createEffect(() =>
 * {
 *     log(count());                      // tracked: re-runs when count changes
 *     untrack(() => sendMetric(user())); // user changes do NOT re-run this effect
 * });
 *
 * @see {@link createEffect}
 * @see {@link on} to declare dependencies explicitly instead.
 */
export function untrack<T>(fn: () => T): T
{
    assertFunction(fn, 'untrack', 'Pass the reads as a function: untrack(() => signal()).');

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
