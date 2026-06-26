/**
 * MODULE: reactivity/create-selector
 *
 * createSelector() is a selection-tracking primitive tuned for large lists. The naive
 * approach has every row subscribe to a shared "selected key" signal and compare
 * against its own id, so one selection change re-runs all N row effects. A selector
 * turns that O(n) into O(1): it keeps a Map of key -> producer, and isSelected(key)
 * subscribes the calling effect to THAT key's producer (not the source). When the
 * selection moves, only the old key's and new key's subscribers are notified; every
 * other key is untouched. A key's producer removes itself from the Map when its last
 * subscriber unlinks, so the Map cannot grow unbounded.
 */

import type { Getter, Producer, SelectorOptions } from './types.ts';
import { currentSubscriber, createProducer, track, notify } from './graph.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';

/**
 * createSelector
 *
 * PURPOSE:
 * Given a source getter of the currently selected key, returns isSelected(key): a
 * reactive predicate that is true when key is selected and, when read inside an
 * effect, subscribes that effect only to that key's selection state.
 *
 * WHY IT EXISTS:
 * Per-row subscription to a shared selection signal makes selection changes O(n) in the
 * list length - every row re-runs even though only two changed appearance. For long
 * lists that dominates interaction cost. The selector localizes the dependency to a
 * per-key producer so a change re-runs exactly the two affected rows.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage; a list-rendering performance primitive. Used by row
 * effects in large collections (tables, virtualized lists).
 *
 * INPUT CONTRACT:
 * - source: getter returning the current selected key.
 * - equals: key comparator, defaults to Object.is.
 *
 * OUTPUT CONTRACT:
 * - Returns (key) => boolean. Called inside an effect it subscribes that effect to
 *   `key`'s producer; called outside any effect it just compares (no subscription).
 *
 * WHY THIS DESIGN:
 * Interposing one producer per observed key (created lazily on first isSelected(key)
 * inside an effect, dropped when its last subscriber leaves) is what makes the change
 * notification touch only the old and new keys. The internal effect bumps each
 * affected producer's version before notify so dependent effects, which validate
 * versions before re-running, do not skip the change.
 *
 * WHEN TO USE:
 * For "is this item the selected/active/hovered one" across many items, where a
 * selection change should repaint only the two affected items.
 *
 * WHEN NOT TO USE:
 * For a handful of items (a plain signal comparison is simpler and the O(n) cost is
 * negligible). Not for multi-select sets - this models a single current key.
 *
 * EDGE CASES:
 * - isSelected(key) read outside an effect returns the current boolean but creates no
 *   producer and no subscription.
 * - A key's producer is removed when its last subscriber unlinks, so re-selecting a key
 *   later lazily recreates it.
 *
 * PERFORMANCE NOTES:
 * Selection change is O(1) in list size (two producers notified). Memory is one
 * producer per key currently observed by a live effect, reclaimed on unsubscribe.
 *
 * DEVELOPER WARNING:
 * The boolean is only reactive when isSelected is read INSIDE an effect; reading it in
 * plain code gives a one-shot value that will not update.
 *
 * @typeParam T - The selection key type.
 * @param source - Getter returning the currently selected key.
 * @param equals - Key equality; defaults to Object.is.
 * @returns A reactive predicate (key) => boolean.
 * @see {@link createSignal}
 * @see {@link createEffect}
 * @example
 * const [selectedId, setSelectedId] = createSignal(1);
 * const isSelected = createSelector(selectedId);
 * createEffect(() => el.classList.toggle('selected', isSelected(id)));
 * setSelectedId(2); // only the old (1) and new (2) row effects re-run
 *
 * @example
 * // Custom equality (same `{ equals }` shape as createSignal / createMemo):
 * const isSelected = createSelector(selected, { equals: (a, b) => a.id === b.id });
 */
export function createSelector<T>(
    source: Getter<T>,
    options: SelectorOptions<T> = {}
): (key: T) => boolean
{
    const equals = options.equals ?? Object.is;

    // key -> a producer holding the effects that called isSelected(key).
    const keyProducers = new Map<T, Producer>();

    // The current selected value, updated by the internal effect below.
    let currentValue: T = untrack(() => source());

    // Re-run every effect registered under one key. The selection flip IS the value
    // change, so the version must advance or version-validating effects would skip it.
    function notifyKey(key: T): void
    {
        const producer = keyProducers.get(key);
        if (producer)
        {
            producer.version++;
            notify(producer);
        }
    }

    // Watch the source; on a change, notify only the old and new keys.
    createEffect(() =>
    {
        const newValue = source();

        if (!equals(currentValue, newValue))
        {
            const oldValue = currentValue;
            currentValue = newValue;

            untrack(() =>
            {
                notifyKey(oldValue);
                notifyKey(newValue);
            });
        }
    });

    // Called inside an effect, subscribe that effect to this key's producer (not the
    // source), so it re-runs only when this key's selection state flips.
    return function isSelected(key: T): boolean
    {
        if (currentSubscriber !== null && !currentSubscriber.isDisposed)
        {
            let producer = keyProducers.get(key);
            if (!producer)
            {
                producer = createProducer();
                // Drop empty key producers so the Map doesn't grow unbounded.
                producer.onUnsubscribed = (): void =>
                {
                    keyProducers.delete(key);
                };
                keyProducers.set(key, producer);
            }

            track(producer);
        }

        return equals(currentValue, key);
    };
}
