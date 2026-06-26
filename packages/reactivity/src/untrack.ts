/**
 * MODULE: reactivity/untrack
 *
 * untrack() reads reactive sources without subscribing the active consumer. It is
 * the escape hatch for "I need this value now, but I do not want to re-run when it
 * changes" - reading peripheral state for a side effect, or calling a setter from
 * inside an effect without forming a feedback loop. It works by clearing the
 * current-subscriber slot for the duration of `fn`, so getters called inside see no
 * subscriber and register no dependency.
 */

import { currentSubscriber, setCurrentSubscriber } from './graph.ts';
import { assertFunction } from './validate.ts';

/**
 * untrack
 *
 * PURPOSE:
 * Runs `fn` with dependency tracking suspended and returns its result. Signals/memos
 * read inside `fn` do not subscribe the active effect or memo.
 *
 * WHY IT EXISTS:
 * Tracking is automatic: every reactive read inside a consumer subscribes it. That is
 * usually what you want, but sometimes a consumer must observe a value's current
 * state without taking a dependency on it - otherwise it re-runs on changes it should
 * ignore, or a setter call re-triggers the very effect making it (a feedback loop).
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. A tracking-scope control, orthogonal to the render
 * pipeline; used inside effects/memos to carve out non-reactive reads.
 *
 * INPUT CONTRACT:
 * - fn is run immediately with the current subscriber cleared. It may read or write
 *   signals; reads do not subscribe.
 *
 * OUTPUT CONTRACT:
 * - Returns fn's return value. The previous subscriber is restored afterwards, even
 *   if fn throws.
 *
 * WHY THIS DESIGN:
 * Clearing the single current-subscriber slot (rather than per-signal opt-outs) makes
 * the boundary explicit and exact: everything read inside the callback is untracked,
 * nothing outside it is affected, and restoration in `finally` keeps tracking correct
 * across exceptions.
 *
 * WHEN TO USE:
 * To read peripheral/contextual state inside an effect without re-running on it, or to
 * call a setter from inside an effect/memo without self-triggering.
 *
 * WHEN NOT TO USE:
 * Not as a blanket performance hack - untracking a value you actually depend on makes
 * the consumer miss legitimate updates and go stale.
 *
 * EDGE CASES:
 * - Nested untrack() is fine; the innermost restores to the previous (already-cleared)
 *   state.
 * - Writes inside fn still notify other subscribers normally; only the act of reading
 *   is non-subscribing.
 *
 * PERFORMANCE NOTES:
 * O(1) overhead: one save and one restore of the subscriber slot around fn.
 *
 * DEVELOPER WARNING:
 * Anything read inside fn is invisible to the dependency graph - if the consumer
 * should react to it, do not untrack it.
 *
 * @typeParam T - fn's return type.
 * @param fn - The function to run with tracking suspended.
 * @returns Whatever `fn` returns.
 * @see {@link createEffect}
 * @see {@link createMemo}
 * @example
 * createEffect(() => {
 *     log(count());                      // tracked: re-runs when count changes
 *     untrack(() => sendMetric(user())); // user changes do NOT re-run this effect
 * });
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
