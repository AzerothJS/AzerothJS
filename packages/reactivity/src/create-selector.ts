// createSelector() creates a reactive selection checker optimized for large
// lists. When the selection changes, instead of re-running every item's
// effect, only two are notified: the previously selected item (now
// deselected) and the newly selected one.
//
// The naive approach has each list item subscribe to the selection signal and
// compare against its own id; changing the selection then re-runs all N item
// effects. createSelector turns that O(n) change into O(1).
//
// It keeps a Map of key -> Set<Subscriber>. Calling isSelected(key) inside an
// effect registers that effect under that specific key (not the source
// signal). When the source changes, only the subscribers under the old key
// and the new key are notified; every other key is left untouched.

import type { Getter, Subscriber } from './types.ts';
import { currentSubscriber } from './signal.ts';
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
    // key -> the effects that called isSelected(key).
    const subscribers = new Map<T, Set<Subscriber>>();

    // The current selected value, updated by the internal effect below.
    let currentValue: T = untrack(() => source());

    // Re-runs every effect registered under one key.
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
            let subs = subscribers.get(key);
            if (!subs)
            {
                subs = new Set();
                subscribers.set(key, subs);
            }

            // Subscribe to the key at most once even if isSelected(key) is
            // called several times in one run. `subs.add` is idempotent, but
            // the cleanup below is a fresh closure each call, so the `has`
            // guard is what keeps `dependencies` free of duplicates. This is
            // the hottest path - createSelector exists for large lists.
            if (!subs.has(currentSubscriber))
            {
                const sub = currentSubscriber;
                const keySubs = subs;
                keySubs.add(sub);

                sub.dependencies.add(() =>
                {
                    keySubs.delete(sub);
                    // Drop empty key sets so the Map doesn't grow unbounded.
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
