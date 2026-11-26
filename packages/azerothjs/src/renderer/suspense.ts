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
import { isBufferedResourcePending } from '../reactivity/create-resource.ts';
import { batch, createEffect, createMemo, createSignal, getOwner, isHydrating, isStringMode, runInMode, runWithOwner, untrack } from '../reactivity/index.ts';
import {
    currentStreamSession, hydrationNode, seedBoundary,
    serializeChild, wrapContentsAnchored
} from '../reactivity/internal.ts';
import type { HydrationCursor } from '../reactivity/internal.ts';
import { adoptCoRange, clearCo } from '../component/co-range.ts';
import type { MountNode } from '../component/index.ts';
import { claimStreamBoundary, discardStreamRange } from './stream-swap.ts';
import { driveShow, Show } from './show.ts';

/** Props for {@link Suspense}. */
export interface SuspenseProps
{
    /** Rendered while any watched resource is loading. */
    fallback: () => MountNode;

    /**
     * The resources to watch: the fallback shows while ANY of them reports loading. The list
     * is captured at construction. Keep the same resources in the same order on the server
     * and client so each streamed outcome reaches its owner. An empty list renders the children.
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
 * A buffered server render shows the children when every watched resource is ready.
 * An unseeded resource created during that render waits for its first read on the client
 * and shows the fallback. A streaming render emits the fallback under a numbered marker and streams
 * the children as an out-of-order chunk once the watched fetches settle - or, if they had
 * already settled, renders the children inline and sends their seeds with the enclosing chunk.
 * An empty watch list retains the bare marker.
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
            // Keep the full list: an options seed or loader view has a position even though
            // the server made no fetch for it. A settled fetch still has an outcome to send.
            const resources = props.on;
            const entries = resources.map(resource => session.fetchOf(resource));
            if (!entries.some(entry => entry !== undefined))
            {
                return wrapContentsAnchored(resources.length === 0 ? 'suspense' : 'suspense:ready', serializeChild(props.children())) as unknown as MountNode;
            }
            const id = session.allocateBoundaryId();
            if (!resources.some((resource, i) => entries[i] !== undefined && untrack(resource.loading)))
            {
                const children = serializeChild(props.children());
                session.registerInlineSeeds({ id, entries });
                return wrapContentsAnchored(`suspense:${ id }`, children) as unknown as MountNode;
            }
            const owner = getOwner();
            const fallbackHtml = serializeChild(props.fallback());
            session.registerBoundary({
                id,
                entries,
                render: (): string => runWithOwner(owner, () => serializeChild(props.children()))
            });
            return wrapContentsAnchored(`suspense:${ id }`, fallbackHtml) as unknown as MountNode;
        }
        const resources = props.on;
        if (untrack(() => resources.some(isBufferedResourcePending)))
        {
            return wrapContentsAnchored('suspense:fallback', serializeChild(props.fallback())) as unknown as MountNode;
        }
        return wrapContentsAnchored(resources.length === 0 ? 'suspense' : 'suspense:ready', serializeChild(props.children())) as unknown as MountNode;
    }

    // This exact list owns both the wire indexes and the subsequent loading checks.
    const resources = untrack(() => [...props.on]);
    const resourcesReady = (): boolean => !resources.some(resource => resource.loading());

    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursor): void =>
        {
            const open = cursor.peek();
            const marker = open?.nodeType === 8 ? (open as Comment).data : '';
            const id = /^azc:suspense:(\d+)$/.exec(marker)?.[1];
            let served: boolean | undefined;
            let rebuild = false;
            if (id !== undefined)
            {
                served = claimStreamBoundary(open as Comment);
                const seeded = untrack(() => runInMode('dom', () => batch(() => seedBoundary(id, resources))));
                rebuild = seeded === false || (served === true && seeded !== true)
                    || (seeded === true && !untrack(resourcesReady));
                // A settled boundary inline in a parent chunk has seeds but no swap of its own.
                served = rebuild ? false : seeded ?? served;
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
            const branches = {
                when: ready,
                fallback: () => props.fallback(),
                children: () => props.children()
            };
            const { target, contentCursor } = adoptCoRange(cursor);
            if (rebuild)
            {
                // A public refetch or older wire can leave ready HTML with no usable data.
                // Replacing just this range preserves the pending request and its callers.
                discardStreamRange(target.start, target.end);
                clearCo(target);
                runInMode('dom', () => driveShow(branches, target, false));
            }
            else
            {
                driveShow(branches, target, true, contentCursor);
            }
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
