/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createMemo, getOwner, onRootDispose, type DisposeFn } from '../reactivity/index.ts';
import { currentErrorHandler } from '../reactivity/catch-error.ts';
import { routeAsyncError } from '../reactivity/create-effect.ts';
import type { HydrationCursor } from '../reactivity/internal.ts';
import { appendToCo, clearCo, type CoTarget } from '../component/index.ts';
import { reportTeardownErrors } from '../component/destroy-component.ts';
import { hydrateChild, materializeChild } from './h.ts';
import type { Child } from './types.ts';
import { withHydrationRoots } from './adopt-roots.ts';

/** Adopt the completed work into its caller. A failed construction releases even an ownerless selector. */
export function ownBranchWork<T>(build: () => T, adopt: (dispose: DisposeFn) => void = onRootDispose): T
{
    let stop!: DisposeFn;
    const value = withHydrationRoots(open => open(dispose =>
    {
        stop = dispose;
        return build();
    }));
    adopt(stop);
    return value;
}

/** Each failed evaluation is a distinct selection, even if application code rethrows the same object. */
export class FailedSelection
{
    readonly #error: unknown;
    #delivered = false;

    constructor(error: unknown)
    {
        this.#error = error;
        // The outgoing cleanup can throw before the effect reaches its new selection.
        // In that case the originating handler must still receive this independent error.
        const handler = currentErrorHandler;
        queueMicrotask(() =>
        {
            if (!this.#delivered)
            {
                this.#delivered = true;
                routeAsyncError(error, handler, undefined);
            }
        });
    }

    public raise(): never
    {
        this.#delivered = true;
        throw this.#error;
    }
}

/** Let the swap effect deliver a predicate error after retiring the old branch. */
export function createSelectionMemo<T>(select: () => T, mounted: () => boolean): () => T | FailedSelection
{
    let cleanupFailure: FailedSelection | undefined;
    return createMemo(() =>
    {
        const previous = cleanupFailure;
        cleanupFailure = undefined;
        const owner = getOwner();
        try
        {
            const value = ownBranchWork(select, stop =>
            {
                // Resample even after failed teardown to subscribe to the current guards.
                // Discard that attempt's content because the failure wins this selection.
                if (previous)
                {
                    stop();
                    return;
                }
                onRootDispose(() =>
                {
                    try
                    {
                        stop();
                    }
                    catch (error)
                    {
                        if (owner?.disposed)
                        {
                            throw error;
                        }
                        // A memo drains its previous run before entering the new compute.
                        // Throwing here would interrupt validation before it can close the branch.
                        cleanupFailure = new FailedSelection(error);
                    }
                });
            });
            return previous ?? value;
        }
        catch (error)
        {
            const failure = new FailedSelection(error);
            return previous ?? failure;
        }
    }, { equals: (a, b) => mounted() && Object.is(a, b) });
}

type BranchBuild = ((adopting: boolean) => Child) | FailedSelection | undefined;
interface BranchMount
{
    mounted: () => boolean;
    mount: (choose: () => BranchBuild) => DisposeFn;
}

/** Own the active range. Only a successfully built branch may suppress a same-selection retry. */
export function createBranchMount(target: CoTarget, cursor: HydrationCursor | undefined, label: string): BranchMount
{
    let dispose: DisposeFn | null = null;
    let complete = false;
    const teardown = (): void =>
    {
        complete = false;
        const outgoing = dispose;
        dispose = null;
        clearCo(target, outgoing);
    };

    function mount(choose: () => BranchBuild): DisposeFn
    {
        const adoption = cursor;
        cursor = undefined;
        try
        {
            const build = choose();
            if (build instanceof FailedSelection)
            {
                return build.raise();
            }
            withHydrationRoots(open =>
            {
                if (build)
                {
                    open(stop =>
                    {
                        dispose = stop;
                        const child = build(adoption !== undefined);
                        if (adoption)
                        {
                            hydrateChild(child, adoption);
                        }
                        else
                        {
                            appendToCo(target, materializeChild(child));
                        }
                    });
                }
                adoption?.assertExhausted(label);
            });
        }
        catch (error)
        {
            // The root transaction has already disposed the unfinished build. Discard
            // partial or served nodes so a handled failure can retry in the fresh path.
            dispose = null;
            try
            {
                clearCo(target);
            }
            catch (cleanupError)
            {
                reportTeardownErrors([error, cleanupError]);
            }
            throw error;
        }
        complete = true;
        return teardown;
    }
    return { mount, mounted: (): boolean => complete };
}
