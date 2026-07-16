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

import type { Resource } from '@azerothjs/reactivity';
import { createMemo, isStringMode, serializeChild, wrapContentsAnchored } from '@azerothjs/reactivity';
import type { MountNode } from '@azerothjs/component';
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
 *   on: [router.loader],
 *   children: () => Routes({ router })
 * });
 */
export function Suspense(props: SuspenseProps): MountNode
{
    // SSR: resources don't resolve within a synchronous render, so emit the fallback (async
    // SSR is a later phase); the client resolves them and swaps in children after hydration.
    if (isStringMode())
    {
        return wrapContentsAnchored('suspense', serializeChild(props.fallback())) as unknown as MountNode;
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
