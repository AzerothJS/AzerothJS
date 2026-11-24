/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createMemo, getOwner, onRootDispose, untrack, type DisposeFn, type Owner } from '../reactivity/index.ts';
import { currentCleanups } from '../reactivity/graph.ts';
import { withHydrationRoots as withBranchRoots } from './adopt-roots.ts';

/** One showing's last observed truthy value. An escaped reader keeps only the value after disposal. */
class BranchValue<W>
{
    #value: NonNullable<W>;
    #live: { owner: Owner | null; source: () => W; pull?: () => NonNullable<W> } | undefined;

    constructor(source: () => W, owner: Owner | null)
    {
        this.#value = untrack(source) as NonNullable<W>;
        this.#live = { owner, source };
        this.#live.pull = createMemo(() =>
        {
            if (this.#live && !this.#live.owner?.disposed)
            {
                this.observe(this.#live.source());
            }
            return this.#value;
        });
        onRootDispose(this.freeze);
    }

    public readonly freeze = (): void =>
    {
        this.#live = undefined;
    };

    public readonly observe = (next: W): void =>
    {
        if (next && this.#live && !this.#live.owner?.disposed)
        {
            this.#value = next;
        }
    };

    public readonly read = (): NonNullable<W> =>
    {
        if (this.#live && !this.#live.owner?.disposed)
        {
            this.#live.pull?.();
        }
        return this.#value;
    };
}

/** Keep user children in their original owner. The binding alone can roll back a failed manual Match.render(). */
export function renderBranchValue<W, T>(source: () => W, build: (read: () => NonNullable<W>, observe: (next: W) => void) => T): T
{
    const owner = getOwner();
    return withBranchRoots(openRoot =>
    {
        let stop!: DisposeFn;
        const binding = openRoot(dispose =>
        {
            stop = dispose;
            return new BranchValue(source, owner);
        });
        // A manual Match.render() can share an effect or memo with other cases. Freeze
        // every binding before any user cleanup can write a source or read a sibling.
        // Leave disposal of the memo and its user-owned work to the normal owner drain.
        const runCleanups = currentCleanups;
        runCleanups?.unshift(binding.freeze);
        try
        {
            const result = build(binding.read, binding.observe);
            onRootDispose(stop);
            return result;
        }
        catch (error)
        {
            // The root transaction retires a failed binding immediately. Its caller's
            // potentially long-lived effect no longer needs to retain the frozen value.
            if (runCleanups)
            {
                runCleanups.splice(runCleanups.indexOf(binding.freeze), 1);
            }
            throw error;
        }
    });
}
