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
import { createEffect, createMemo, createSignal, getOwner, isHydrating, isStringMode, runInMode, runWithOwner, untrack } from '../reactivity/index.ts';
import {
    currentStreamSession, hydrationNode, popSeedScope, pushSeedScope,
    serializeChild, wrapContentsAnchored
} from '../reactivity/internal.ts';
import type { HydrationCursor, HydrationNode, ServerFetch } from '../reactivity/internal.ts';
import type { MountNode } from '../component/index.ts';
import { claimStreamBoundary } from './stream-swap.ts';
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
 * anything. A streaming render emits the fallback under an numbered marker and streams
 * the children as an out-of-order chunk once the watched fetches settle - or, if they had
 * already settled, renders the children inline under a ready marker. An empty watch list retains the bare marker.
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
            // whose resources already settled renders its children inline. An empty watch list
            // can never suspend, so it needs no branch annotation.
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
                return wrapContentsAnchored(props.on.length === 0 ? 'suspense' : 'suspense:ready', serializeChild(props.children())) as unknown as MountNode;
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
        return wrapContentsAnchored('suspense:fallback', serializeChild(props.fallback())) as unknown as MountNode;
    }

    const resourcesReady = (): boolean => !props.on.some(resource => resource.loading());

    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursor): void =>
        {
            const open = cursor.peek();
            const marker = open?.nodeType === 8 ? (open as Comment).data : '';
            const id = /^azc:suspense:(\d+)$/.exec(marker)?.[1];
            let served: boolean | undefined;
            if (id !== undefined)
            {
                served = claimStreamBoundary(open as Comment);
            }
            else if (marker === 'azc:suspense:fallback' || marker === 'azc:suspense:ready')
            {
                served = marker === 'azc:suspense:ready';
            }

            // A resource created by a cold page may still await its first scheduled drive.
            // Claim the served branch once. The memo absorbs the handoff if the same branch
            // is still needed. Legacy unlabelled output follows the original loading inference.
            const [initial, setInitial] = createSignal<boolean | undefined>(served);
            const ready = createMemo(() => initial() ?? resourcesReady());
            let adopting = true;
            const branch = (build: () => MountNode, fallback: boolean): MountNode =>
            {
                if (!adopting || id === undefined)
                {
                    return build();
                }
                pushSeedScope(fallback ? id + 'f' : id);
                try
                {
                    return build();
                }
                finally
                {
                    popSeedScope();
                }
            };
            const shown = Show({
                when: ready,
                fallback: () => branch(props.fallback, true),
                children: () => branch(props.children, false)
            }) as unknown as HydrationNode;
            shown.hydrate(cursor);
            adopting = false;
            if (served !== undefined)
            {
                createEffect(() => runInMode('dom', () =>
                {
                    setInitial(undefined);
                }));
            }
        }) as unknown as MountNode;
    }

    const ready = createMemo(resourcesReady);

    // Delegate the swap to Show: proven, leak-tested, with per-branch createRoot ownership and
    // destroyComponent on swap.
    return Show({
        when: ready,
        fallback: props.fallback,
        children: props.children
    });
}
