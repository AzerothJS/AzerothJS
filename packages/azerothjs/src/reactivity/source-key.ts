/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createMemo } from './create-memo.ts';
import { getOwner, setCurrentOwner } from './create-root.ts';
import type { EqualsFn, Getter } from './types.ts';
import { untrack } from './untrack.ts';

/** A distinct record represents a change of logical key, including recovery from an error. */
export type SourceKey<S> = { kind: 'value'; value: S } | { kind: 'skip' } | { kind: 'error'; error: unknown };

/** The driving effect reads this after construction, so batching and string rendering retain their timing. */
export function createSourceKey<S>(
    source: Getter<S | false | null | undefined>,
    equals: EqualsFn<S> | undefined,
    refresh: Getter<number>
): Getter<SourceKey<S>>
{
    const owner = getOwner();
    let memo: Getter<SourceKey<S>> | undefined;
    let previous: SourceKey<S> = { kind: 'skip' };

    function compute(): SourceKey<S>
    {
        refresh(); // An explicit retry samples nonreactive inputs and can recover from a source failure.
        try
        {
            const value = source();
            const prior = previous;
            if (value === false || value === null || value === undefined)
            {
                if (prior.kind !== 'skip')
                {
                    previous = { kind: 'skip' };
                }
            }
            else if (prior.kind !== 'value' || !(equals === undefined
                ? Object.is(prior.value, value)
                : untrack(() => equals(prior.value, value))))
            {
                previous = { kind: 'value', value };
            }
        }
        catch (error)
        {
            // The driver owns cancellation and error routing. Publish failures just like key changes.
            previous = { kind: 'error', error };
        }
        return previous;
    }

    return () =>
    {
        if (memo === undefined)
        {
            // Outlive the drive's per-run teardown while keeping its captured catchError handler.
            const drivingOwner = setCurrentOwner(owner);
            try
            {
                memo = createMemo(compute);
            }
            finally
            {
                setCurrentOwner(drivingOwner);
            }
        }
        return memo();
    };
}
