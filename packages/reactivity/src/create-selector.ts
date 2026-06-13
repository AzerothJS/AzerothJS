// createSelector() creates a reactive selection checker optimized for large
// lists. When the selection changes, instead of re-running every item's
// effect, only two are notified: the previously selected item (now
// deselected) and the newly selected one.
//
// The naive approach has each list item subscribe to the selection signal and
// compare against its own id; changing the selection then re-runs all N item
// effects. createSelector turns that O(n) change into O(1).
//
// It keeps a Map of key -> producer node. Calling isSelected(key) inside an
// effect links that effect to that specific key's producer (not the source
// signal). When the source changes, only the subscribers under the old key
// and the new key are notified; every other key is left untouched. A key's
// producer removes itself from the map when its last subscriber unlinks.

import type { Getter, Producer } from './types.ts';
import { currentSubscriber, createProducer, track, notify } from './graph.ts';
import { createEffect } from './effect.ts';
import { untrack } from './untrack.ts';

/**
 * Creates a reactive selector for tracking which item in a list is selected.
 * Returns `isSelected(key)`, which reactively checks whether `key` matches the
 * current source value. On a selection change only the effects checking the
 * old and new keys re-run; all others are skipped - an O(1) change versus the
 * O(n) of a naive signal comparison.
 *
 * @typeParam T - The type of the selection key (string, number, etc.)
 *
 * @param source - A signal getter returning the currently selected key
 * @param equals - Custom key equality. Defaults to `Object.is`.
 *
 * @returns `(key: T) => boolean`, reactively true when `key` is selected
 *
 * Why: if every row subscribes to the selection signal, one selection change
 * re-runs all N rows even though only two visibly changed.
 *
 * Without createSelector: each row reads the shared signal directly:
 *
 *     createEffect(() =>
 *     {
 *         el.classList.toggle('selected', selectedId() === id);
 *     }); // changing selectedId() re-runs this for all N rows
 *
 * With createSelector: a row subscribes to its own key, not the source:
 *
 *     const isSelected = createSelector(selectedId);
 *     createEffect(() =>
 *     {
 *         el.classList.toggle('selected', isSelected(id));
 *     }); // a change re-runs only the old and new rows, O(1)
 *
 * @example
 * ```ts
 * const [selectedId, setSelectedId] = createSignal(1);
 * const isSelected = createSelector(selectedId);
 *
 * isSelected(1);  // true
 * isSelected(2);  // false
 *
 * setSelectedId(2);
 * isSelected(1);  // false
 * isSelected(2);  // true
 * ```
 *
 * @example
 * ```ts
 * // Only the affected items re-render
 * items.forEach(item =>
 * {
 *     createEffect(() =>
 *     {
 *         el.classList.toggle('selected', isSelected(item.id));
 *     });
 * });
 *
 * setSelected('item-5');
 * // Only item-1 (deselected) and item-5 (selected) effects re-run
 * ```
 */
export function createSelector<T>(
    source: Getter<T>,
    equals: (a: T, b: T) => boolean = Object.is
): (key: T) => boolean
{
    // key -> a producer holding the effects that called isSelected(key).
    const keyProducers = new Map<T, Producer>();

    // The current selected value, updated by the internal effect below.
    let currentValue: T = untrack(() => source());

    // Re-runs every effect registered under one key.
    function notifyKey(key: T): void
    {
        const producer = keyProducers.get(key);
        if (producer)
        {
            // The key's selection state flipped - that IS the value change.
            // Effects validate dependency versions before re-running, so the
            // version must advance or they would skip the notification.
            producer.version++;
            notify(producer);
        }
    }

    // Watch the source. On a change, notify only the old and new keys.
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

    // The selector. Called inside an effect, it subscribes that effect to this
    // specific key (not the source signal), so it re-runs only when this key's
    // selection state flips.
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
