/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * One coordinated pending state over several resources: the fallback shows while any watched
 * resource is loading, and the children take over once all settle. The alternative is
 * threading each resource's loading() through a Show by hand and re-editing that condition
 * every time a resource is added.
 *
 * Resources are listed explicitly rather than auto-tracked, for two reasons. useLoader
 * returns a resource built at router-creation time, which creation-context tracking would
 * miss entirely; and auto-tracking across later effect re-runs needs an owner-chained
 * observer, a much larger primitive change. An explicit list is predictable and needs no new
 * infrastructure, and auto-tracking can still arrive later behind the same props.
 *
 * The implementation is a thin layer over {@link Show}: a memo collapses the loading getters
 * into one boolean, so the swap fires only when the "any loading" answer actually flips.
 * Suspense pairs with ErrorBoundary - failures route to the boundary, pending work here.
 */

import type { Resource } from '../reactivity/index.ts';
import { createMemo, getOwner, isHydrating, isStringMode, runWithOwner, untrack } from '../reactivity/index.ts';
import {
    currentStreamSession, hydrationNode, popSeedScope, pushSeedScope,
    serializeChild, wrapContentsAnchored
} from '../reactivity/internal.ts';
import type { HydrationCursor, HydrationNode, ServerFetch } from '../reactivity/internal.ts';
import type { MountNode } from '../component/index.ts';
import { Show } from './show.ts';

/** Props for {@link Suspense}. */
export interface SuspenseProps
{
    /** Rendered while any watched resource is loading. */
    fallback: () => MountNode;

    /**
     * The resources to watch: the fallback shows while ANY of them reports loading. The list
     * is captured at construction and mutating the array afterwards is not observed, so pass
     * stable references rather than a signal-derived array. An empty list always renders the
     * children.
     */
    on: Resource<unknown>[];

    /** The subtree revealed once every watched resource has settled. */
    children: () => MountNode;
}

/**
 * Renders `fallback` while any resource in `on` is loading, and `children` once all have
 * settled: an all-or-nothing reveal over one or more async resources.
 *
 * `on` is captured at construction, so a resource created later - on navigation, say - is not
 * picked up unless Suspense is re-mounted with the new list.
 *
 * A buffered server render emits the fallback, since a synchronous render cannot await
 * anything. A streaming render emits the fallback under an id-suffixed marker and streams
 * the children as an out-of-order chunk once the watched fetches settle - or, if they had
 * already settled, renders the children inline, byte-identical to a buffered render of that
 * settled state.
 *
 * For per-item skeletons, render each resource's own `loading()` instead.
 *
 * @param props - See {@link SuspenseProps}.
 * @returns A handle that swaps fallback and children reactively.
 * @see {@link Show}, which drives the swap.
 * @example
 * Suspense({
 *   fallback: () => h('div', { class: 'spinner' }),
 *   on: [useLoader(userRoute)],
 *   children: () => Routes({ router })
 * });
 */
export function Suspense(props: SuspenseProps): MountNode
{
    if (isStringMode())
    {
        const session = currentStreamSession();
        if (session !== null)
        {
            // A boundary with pending resources emits its fallback under an ID-SUFFIXED marker
            // and registers a continuation the driver streams once those fetches settle. One
            // whose resources already settled renders its children inline under the bare marker,
            // byte-identical to a buffered render of that state.
            const pending: ServerFetch[] = [];
            for (const resource of props.on)
            {
                if (untrack(resource.loading))
                {
                    const entry = session.fetchOf(resource);
                    if (entry !== undefined)
                    {
                        pending.push(entry);
                    }
                }
            }
            if (pending.length === 0)
            {
                return wrapContentsAnchored('suspense', serializeChild(props.children())) as unknown as MountNode;
            }
            const id = session.allocateBoundaryId();
            const owner = getOwner();
            const fallbackHtml = session.inScope(`${ id }f`, () => serializeChild(props.fallback()));
            session.registerBoundary({
                id,
                entries: pending,
                render: (): string => runWithOwner(owner, () => session.inScope(String(id), () => serializeChild(props.children())))
            });
            return wrapContentsAnchored(`suspense:${ id }`, fallbackHtml) as unknown as MountNode;
        }
        // Buffered SSR: resources cannot resolve within a synchronous render, so emit the
        // fallback and let the client resolve them and swap after hydration.
        return wrapContentsAnchored('suspense', serializeChild(props.fallback())) as unknown as MountNode;
    }

    if (isHydrating())
    {
        // A streamed boundary's marker carries its id, so pushing the matching seed scope around
        // the children makes their resources re-derive the server's ids and adopt the seeds. The
        // scope is LATE-BOUND from the adopted marker, peeked rather than consumed since Show's
        // own adoption claims it, while the memo and Show build eagerly so construction ownership
        // matches every other mode. A bare marker means no scope and unchanged behaviour.
        let seedScope: string | null = null;
        const children = (): MountNode =>
        {
            if (seedScope === null)
            {
                return props.children();
            }
            pushSeedScope(seedScope);
            try
            {
                return props.children();
            }
            finally
            {
                popSeedScope();
            }
        };
        const anyLoading = createMemo<boolean>(() =>
        {
            for (const resource of props.on)
            {
                if (resource.loading())
                {
                    return true;
                }
            }
            return false;
        });
        const shown = Show({
            when: () => !anyLoading(),
            fallback: props.fallback,
            children
        }) as unknown as HydrationNode;
        return hydrationNode((cursor: HydrationCursor): void =>
        {
            const open = cursor.peek();
            const match = open !== null && open.nodeType === 8
                ? /^azc:suspense:(\d+)$/.exec((open as Comment).data)
                : null;
            if (match !== null)
            {
                seedScope = match[1] as string;
            }
            shown.hydrate(cursor);
        }) as unknown as MountNode;
    }

    // Collapse N loading getters into one boolean. Show re-evaluates `when` on signal change;
    // the memo's equality means Show's effect re-runs only when the answer genuinely flips.
    const anyLoading = createMemo<boolean>(() =>
    {
        for (const resource of props.on)
        {
            if (resource.loading())
            {
                return true;
            }
        }
        return false;
    });

    // Delegate the swap to Show: proven, leak-tested, with per-branch createRoot ownership and
    // destroyComponent on swap.
    return Show({
        when: () => !anyLoading(),
        fallback: props.fallback,
        children: props.children
    });
}
