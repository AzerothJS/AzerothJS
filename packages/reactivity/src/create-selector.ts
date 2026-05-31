// ============================================================================
// AZEROTHJS — createSelector (Efficient Selection Tracking)
// ============================================================================
//
// createSelector() creates a reactive selection checker optimized
// for large lists. Instead of every item re-running its effect
// when the selection changes, only TWO items are notified:
//   1. The previously selected item (deselected)
//   2. The newly selected item (selected)
//
// WHY?
//
//   Naive approach — every item subscribes to selectedId:
//
//     const [selectedId, setSelectedId] = createSignal(1);
//
//     // In each list item (imagine 10,000 items):
//     createEffect(() =>
//     {
//         if (selectedId() === item.id) { ... }
//     });
//     // ALL 10,000 effects re-run on every selection change!
//
//   With createSelector — only 2 items are notified:
//
//     const isSelected = createSelector(selectedId);
//
//     // In each list item:
//     createEffect(() =>
//     {
//         if (isSelected(item.id)) { ... }
//     });
//     // Only the OLD and NEW selected items re-run!
//
// HOW IT WORKS:
//
//   1. Maintains a Map of key → Set<Subscriber>
//   2. When isSelected(key) is called inside an effect,
//      that effect is registered under that specific key
//   3. When the source signal changes:
//      a. Look up subscribers for the OLD value → notify them
//      b. Look up subscribers for the NEW value → notify them
//      c. All other subscribers are untouched
//
//   Selection: 1 → 3
//     key=1 subscribers: re-run (now false)
//     key=2 subscribers: NOT notified ✨
//     key=3 subscribers: re-run (now true)
//     key=4 subscribers: NOT notified ✨
//     ...
//     key=10000 subscribers: NOT notified ✨
//
// ============================================================================

import type { Getter, Subscriber } from './types.ts';
import { currentSubscriber } from './signal.ts';
import { createEffect } from './effect.ts';
import { untrack } from './untrack.ts';

/**
 * Creates a reactive selector function optimized for tracking
 * which item in a list is "selected".
 *
 * Returns a function `isSelected(key)` that reactively checks
 * if the given key matches the current source value. Only
 * effects checking the previously selected and newly selected
 * keys are notified — all others are skipped.
 *
 * This is an O(1) selection change vs O(n) with naive signal
 * comparison.
 *
 * @typeParam T - The type of the selection key (string, number, etc.)
 *
 * @param source - A signal getter returning the currently selected key
 * @param equals - Optional custom equality function for comparing keys.
 *                 Defaults to `Object.is`.
 *
 * @returns A function `(key: T) => boolean` that reactively
 *          checks if `key` matches the current selection
 *
 * @example
 * ```ts
 * // Basic selection tracking
 * const [selectedId, setSelectedId] = createSignal(1);
 * const isSelected = createSelector(selectedId);
 *
 * isSelected(1);  // → true
 * isSelected(2);  // → false
 *
 * setSelectedId(2);
 * isSelected(1);  // → false
 * isSelected(2);  // → true
 * ```
 *
 * @example
 * ```ts
 * // Efficient list rendering — only affected items re-render
 * const [selected, setSelected] = createSignal('item-1');
 * const isSelected = createSelector(selected);
 *
 * items.forEach(item =>
 * {
 *     createEffect(() =>
 *     {
 *         // Only runs when THIS item's selection state changes
 *         el.classList.toggle('selected', isSelected(item.id));
 *     });
 * });
 *
 * setSelected('item-5');
 * // Only item-1 (deselected) and item-5 (selected) effects re-run
 * ```
 *
 * @example
 * ```ts
 * // With custom equality
 * const isSelected = createSelector(selectedId, (a, b) =>
 *     a.toLowerCase() === b.toLowerCase()
 * );
 * ```
 */
export function createSelector<T>(
    source: Getter<T>,
    equals: (a: T, b: T) => boolean = Object.is
): (key: T) => boolean
{
    /**
     * Map of key → subscribers interested in that specific key.
     *
     * When isSelected(key) is called inside an effect,
     * that effect is added to the Set for that key.
     */
    const subscribers = new Map<T, Set<Subscriber>>();

    /**
     * The current selected value. Updated by the internal effect.
     */
    let currentValue: T = untrack(() => source());

    /**
     * Notifies all subscribers registered under a specific key.
     * Each subscriber's execute() is called to re-run its effect.
     *
     * @param key - The key whose subscribers should be notified
     */
    function notifyKey(key: T): void
    {
        const subs = subscribers.get(key);
        if (!subs)
        {
            return;
        }

        for (const sub of Array.from(subs))
        {
            if (!sub.isDisposed)
            {
                sub.execute();
            }
            else
            {
                subs.delete(sub);
            }
        }
    }

    // Internal effect watches the source signal.
    // When it changes, only the old and new key subscribers
    // are notified — not every subscriber.
    createEffect(() =>
    {
        const newValue = source();

        if (!equals(currentValue, newValue))
        {
            const oldValue = currentValue;
            currentValue = newValue;

            // Notify ONLY the two affected keys
            untrack(() =>
            {
                notifyKey(oldValue);
                notifyKey(newValue);
            });
        }
    });

    /**
     * The selector function. Returns true if the given key
     * matches the current source value.
     *
     * When called inside an effect, subscribes that effect
     * to be notified ONLY when THIS key's selection state
     * changes — not on every source update.
     */
    return function isSelected(key: T): boolean
    {
        // If there's an active subscriber (effect), register it
        // under this specific key — NOT to the source signal
        if (currentSubscriber !== null && !currentSubscriber.isDisposed)
        {
            let subs = subscribers.get(key);
            if (!subs)
            {
                subs = new Set();
                subscribers.set(key, subs);
            }

            // Subscribe this effect to the key only ONCE, even if it
            // calls isSelected(key) several times in a single run.
            // `subs.add` is idempotent, but the cleanup below is a
            // fresh closure every call — guarding on `subs.has`
            // keeps `dependencies` free of duplicates. This matters:
            // createSelector exists for large lists, so this is the
            // hottest path in the framework.
            if (!subs.has(currentSubscriber))
            {
                const sub = currentSubscriber;
                const keySubs = subs;
                keySubs.add(sub);

                // Register cleanup so the subscriber can unregister
                // when it's disposed or re-runs
                sub.dependencies.add(() =>
                {
                    keySubs.delete(sub);
                    // Clean up empty sets to prevent memory leaks
                    if (keySubs.size === 0)
                    {
                        subscribers.delete(key);
                    }
                });
            }
        }

        return equals(currentValue, key);
    };
}
