/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Selection tracking for large lists. Having every row subscribe to a shared "selected key"
 * signal makes one selection change re-run all N row effects; a selector keeps a Map of key
 * to producer instead, and isSelected(key) subscribes the calling effect to THAT key's
 * producer rather than to the source. Moving the selection then notifies only the old and
 * new keys.
 *
 * A key's producer removes itself from the Map when its last subscriber unlinks, so the Map
 * cannot grow without bound.
 */

import type { Getter, Producer, SelectorOptions } from './types.ts';
import { currentSubscriber, createProducer, track } from './graph.ts';
import { notifyWrite } from './batch.ts';
import { createEffect } from './create-effect.ts';
import { untrack } from './untrack.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';

/**
 * Given a getter of the currently selected key, returns an `isSelected(key)` predicate that
 * costs one re-run per affected row instead of one per row in the list.
 *
 * Read INSIDE an effect, it subscribes that effect to `key`'s own selection state, so
 * moving the selection re-runs exactly the two rows that changed appearance. Read outside
 * an effect it simply compares: the answer is correct but static, with no producer created
 * and no subscription made.
 *
 * This models a single current key. It is not a multi-select set, and for a handful of
 * items a plain signal comparison is simpler.
 *
 * @typeParam T - The selection key type.
 * @param source - Getter returning the currently selected key.
 * @param options - Optional settings.
 * @param options.equals - Key comparator. Defaults to `Object.is`.
 * @param options.name - Debug name for devtools.
 * @returns A predicate that is reactive when read inside an effect.
 * @example
 * const [selectedId, setSelectedId] = createSignal(1);
 * const isSelected = createSelector(selectedId);
 *
 * // In each row:
 * createEffect(() => element.classList.toggle('selected', isSelected(row.id)));
 *
 * setSelectedId(2); // only rows 1 and 2 re-run, whatever the list length
 *
 * @example
 * // Same `{ equals }` shape as createSignal and createMemo.
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

    let currentValue: T = untrack(() => source());

    // The selection flip IS the value change here, so the version must advance or effects
    // that validate versions before re-running would skip it.
    function notifyKey(key: T): void
    {
        const producer = keyProducers.get(key);
        if (producer)
        {
            producer.version++;
            notifyWrite(producer);
        }
    }

    // On a change, notify only the old and the new key.
    const frame = dtEnterPrimitive('selector', options.name);
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
    }, { name: options.name });
    dtExitPrimitive(frame);

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
