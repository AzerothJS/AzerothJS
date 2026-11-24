/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Tears down a rendered subtree, running any teardown hooks attached to its
 * elements. The renderer's control-flow components (Show, For, Switch, Portal, Transition,
 * ErrorBoundary, and the router's Routes) call it on the nodes they remove on a swap/unmount.
 * Hooks are attached to an element via setDestroyHooks (./destroy-hooks); reactive effects/memos
 * are torn down by their owning createRoot, so this is the place for NON-reactive cleanup that
 * rides on a DOM node.
 */

import { getDestroyHooks, setDestroyHooks, hasAnyDestroyHooks } from './destroy-hooks.ts';
import { currentErrorHandler } from '../reactivity/catch-error.ts';
import { routeAsyncError } from '../reactivity/create-effect.ts';

/**
 * Runs and drains every teardown hook attached to `element` and its descendants.
 *
 * This is NON-reactive cleanup only. Effects and memos are disposed by their owning root;
 * what belongs here is teardown bound to a DOM node rather than a scope - a third-party
 * widget mounted on an element, an observer, a manually added listener.
 *
 * Hooks run in attachment order and are drained afterwards, so a second call on the same
 * subtree is a no-op rather than an error. Mutating the subtree from inside a hook is
 * supported. The walk identifies the elements with hooks before calling any of them, so a hook
 * that detaches a descendant cannot skip its teardown.
 *
 * The built-in removers already call it; reach for it directly only when removing a subtree
 * outside those paths.
 *
 * @param element - The root of the subtree. An element with no hooks is fine.
 * @see {@link createRoot} for reactive teardown.
 */
export function destroyComponent(element: HTMLElement): void
{
    const targets = snapshotDestroyTargets(element);
    if (targets.length === 0)
    {
        return;
    }
    const errors: unknown[] = [];
    drainDestroyHooks(targets, errors);
    reportTeardownErrors(errors);
}

const NO_DESTROY_TARGETS: readonly HTMLElement[] = [];

/** Identify the original hook-bearing subtree before any user cleanup can move its nodes. @internal */
export function snapshotDestroyTargets(root: ChildNode): readonly HTMLElement[]
{
    if (!hasAnyDestroyHooks() || !(root instanceof HTMLElement))
    {
        return NO_DESTROY_TARGETS;
    }
    const targets: HTMLElement[] = [];
    collect(root);
    return targets;

    function collect(element: HTMLElement): void
    {
        if (getDestroyHooks(element)?.length)
        {
            targets.push(element);
        }
        for (const child of element.children)
        {
            if (child instanceof HTMLElement)
            {
                collect(child);
            }
        }
    }
}

/** A nested destroy may already have drained some targets. Read their hook storage at dispatch. @internal */
export function drainDestroyHooks(targets: readonly HTMLElement[], errors: unknown[]): void
{
    for (const element of targets)
    {
        const hooks = getDestroyHooks(element);
        if (!hooks?.length)
        {
            continue;
        }
        setDestroyHooks(element, []);
        for (const hook of hooks)
        {
            try
            {
                hook();
            }
            catch (error)
            {
                errors.push(error);
            }
        }
    }
}

/** Propagate the first failure to the caller and report independent failures asynchronously. @internal */
export function reportTeardownErrors(errors: unknown[]): void
{
    if (errors.length > 0)
    {
        const handler = currentErrorHandler;
        for (const error of errors.slice(1))
        {
            queueMicrotask(() => routeAsyncError(error, handler, undefined));
        }
        throw errors[0];
    }
}
