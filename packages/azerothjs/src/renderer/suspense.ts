/**
 * MODULE: renderer/suspense
 *
 * <Suspense> wraps a subtree, watches a list of Resources, and shows a fallback while ANY of
 * them is loading; when all settle, the children take over. Without it you would thread each
 * resource's loading() through a <Show> by hand, OR-ing them and re-editing the condition as
 * resources are added. Resources are passed explicitly via `on` (not auto-tracked) because
 * (1) useLoader(router) returns a resource built at createRouter time that creation-context
 * tracking would miss, and (2) auto-tracking across later effect re-runs needs an
 * owner-chained observer - a bigger primitive change - whereas an explicit list is
 * predictable and needs no new infrastructure (auto-tracking can ship later behind the same
 * props). It is a thin layer over {@link Show}: a memo collapses the N loading getters into
 * one boolean so Show's swap only fires when the "any loading" answer actually flips. It pairs
 * with <ErrorBoundary>: errors route to the boundary, pending resources to Suspense.
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

/**
 * Props for {@link Suspense}.
 */
export interface SuspenseProps
{
    /** Rendered while any watched resource is loading; replaced by children() once all settle. */
    fallback: () => MountNode;

    /**
     * Resources to watch; Suspense shows the fallback if ANY reports loading() === true. The
     * list is captured at construction (mutating the array is not observed) - pass a stable
     * list of references, not a signal-derived array. An empty array always renders children().
     */
    on: Resource<unknown>[];

    /** The protected subtree, rendered once all watched resources settle. Same factory pattern as <Show>. */
    children: () => MountNode;
}

/**
 * Suspense
 *
 * PURPOSE:
 * Renders `fallback` while any resource in `on` is loading, and `children` once all have
 * settled - a single coordinated pending state over multiple async resources.
 *
 * WHY IT EXISTS:
 * Coordinating several resources' loading flags by hand (a growing `!a.loading() && !b.loading()`
 * condition) is error-prone and re-edited every time a resource is added. Suspense collapses
 * them into one declarative boundary.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; an async-coordination control built on Show. Mode-dispatched via Show
 * plus an SSR branch: in string mode it emits the fallback (resources do not resolve within a
 * synchronous render; async SSR is a later phase), and the client swaps in children after
 * hydration once they settle.
 *
 * INPUT CONTRACT:
 * - fallback / children: thunks (same contract as Show's branches).
 * - on: a stable array of Resources, captured at construction.
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle (delegated to Show) that swaps fallback<->children as
 *   the combined loading state flips. In SSR, the serialized fallback in a contents anchor.
 *
 * WHY THIS DESIGN:
 * A createMemo computes `anyLoading = on.some(r => r.loading())`; feeding `when: () =>
 * !anyLoading()` into Show means the swap effect re-runs only when the boolean genuinely
 * changes (memo equality), not on every resource ripple. Delegating the swap to Show reuses
 * its proven per-branch createRoot ownership and destroy-on-swap behavior.
 *
 * WHEN TO USE:
 * For an all-or-nothing reveal over one or more async resources (a route loader, a dashboard's
 * several fetches), especially alongside <ErrorBoundary>.
 *
 * WHEN NOT TO USE:
 * For per-item skeletons (render each resource's own loading()). For non-async conditionals,
 * use {@link Show}.
 *
 * EDGE CASES:
 * - Empty `on`: always renders children (degenerate no-op).
 * - SSR always shows the fallback (sync render cannot await resources).
 *
 * PERFORMANCE NOTES:
 * One memo over the loading getters; the Show swap fires only on a real flip, not per resource
 * update.
 *
 * DEVELOPER WARNING:
 * `on` is captured at construction - a resource created later (e.g. on navigation) is not
 * picked up unless you re-mount Suspense with the new list. Keep the array references stable.
 *
 * @param props - {@link SuspenseProps}: `fallback`, `on`, `children`.
 * @returns An HTMLElement-typed handle that swaps fallback/children reactively.
 * @see {@link Show}
 * @see {@link createResource}
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
            // STREAMING SSR: a boundary whose resources are pending emits its fallback under
            // an ID-SUFFIXED marker and registers a continuation; the driver streams the
            // children as an out-of-order chunk once the session's fetches settle. A boundary
            // whose resources already settled renders its children inline under the bare
            // marker - byte-identical to a buffered render of the settled state.
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
        // Buffered SSR: resources don't resolve within a synchronous render, so emit the
        // fallback; the client resolves them and swaps in children after hydration.
        return wrapContentsAnchored('suspense', serializeChild(props.fallback())) as unknown as MountNode;
    }

    if (isHydrating())
    {
        // A streamed boundary's marker carries its id; push the matching seed scope around
        // the children so their resources re-derive the server's ids and adopt the seeds.
        // The scope is LATE-BOUND from the adopted marker (peeked, not consumed - Show's
        // own adoption claims it), while the memo and Show build eagerly so construction
        // ownership matches every other mode. Bare markers: no scope, behavior unchanged.
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
