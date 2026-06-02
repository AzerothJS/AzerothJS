// Suspense wraps a subtree, watches a list of `Resource`s, and shows a fallback
// while any of them is loading. When all settle, the children take over.
//
// Without Suspense: thread each resource's loading() through a Show by hand,
// OR-ing them together and re-editing the condition as resources are added.
//
//     Show({
//         when: () => !a.loading() && !b.loading(),
//         fallback: spinner,
//         children: view
//     }); // every new resource means another && to remember
//
// With Suspense: pass the resources in `on` and it collapses their loading
// states into one flip.
//
//     Suspense({
//         on: [a, b],
//         fallback: spinner,
//         children: view
//     }); // shows the fallback until all settle; add to `on`, nothing else
//
// Resources are passed explicitly via the `on` prop rather than auto-tracked,
// for two reasons:
//
//   1. useLoader(router) returns a pre-existing resource constructed at
//      createRouter time, so auto-tracking by creation context would never
//      catch it.
//
//   2. Auto-tracking across later effect re-runs (e.g. a navigation that
//      creates a new resource) needs an observer chained through the reactive
//      owner system - a non-trivial primitive change. An explicit list is
//      predictable and needs zero new infrastructure. Auto-tracking can ship
//      later behind the same props without a breaking change.
//
// Implementation: a thin layer over Show. We compute a memo
// anyLoading = on.some(r => r.loading()) and feed when: () => !anyLoading()
// into Show. The memo gives slice efficiency - subscribers only re-fire when
// the "any loading" answer actually flips, not on every resource update.
//
// Pairs naturally with ErrorBoundary, which handles a disjoint concern: errors
// in the subtree route to the boundary's fallback, pending resources route to
// Suspense's fallback, and the two don't fight.

import type { Resource } from '@azerothjs/reactivity';
import { createMemo, isStringMode, serializeChild, wrapContents } from '@azerothjs/reactivity';
import { Show } from './show.ts';

/**
 * Props for the `<Suspense>` component.
 */
export interface SuspenseProps
{
    /**
     * Renders while any watched resource is loading. Replaced
     * with `children()` once every resource has settled.
     */
    fallback: () => HTMLElement;

    /**
     * Resources to watch. Suspense flips to the fallback if ANY
     * of them reports `loading() === true`.
     *
     * The list is captured at construction - Suspense does not
     * react to mutations of the array itself. Pass a stable
     * list of references, not a signal-derived array.
     *
     * An empty array is valid; in that case Suspense always
     * renders `children()` (the degenerate, no-op case).
     */
    on: Resource<unknown>[];

    /**
     * The protected subtree, rendered once all watched resources
     * have settled. Same factory pattern as `<Show>`.
     */
    children: () => HTMLElement;
}

/**
 * Renders `fallback` while any resource in `on` is loading;
 * renders `children` when all are settled.
 *
 * Designed for ergonomic pairing with `<ErrorBoundary>`: errors
 * route to the boundary, pending resources route to Suspense,
 * and the two handle disjoint failure modes without stepping on
 * each other.
 *
 * @param props - `{ fallback, on, children }`
 *
 * @returns An invisible (`display: contents`) container that
 *          swaps between fallback and children reactively.
 *
 * @example
 * ```ts
 * const userResource = createResource(
 *     () => userId(),
 *     async (id, signal) => fetchUser(id, signal)
 * );
 *
 * Suspense({
 *     fallback: () => h('p', {}, 'Loading user...'),
 *     on: [userResource],
 *     children: () => UserCard({ resource: userResource })
 * });
 * ```
 *
 * @example
 * ```ts
 * // Watching the router's loader resource - pairs with
 * // useLoader inside the route component.
 * Suspense({
 *     fallback: () => h('div', { class: 'spinner' }),
 *     on: [router.loader],
 *     children: () => Routes({ router })
 * });
 * ```
 *
 * @example
 * ```ts
 * // Multiple resources - fallback shows if ANY of them is
 * // pending. All-or-nothing reveal pattern.
 * Suspense({
 *     fallback: loadingView,
 *     on: [profile, posts, friends],
 *     children: () => Dashboard({ profile, posts, friends })
 * });
 * ```
 */
export function Suspense(props: SuspenseProps): HTMLElement
{
    // Server-side rendering.
    // Resources don't resolve within a synchronous render, so emit the
    // fallback (async SSR is a later phase). The client resolves the
    // resources and swaps in `children` after hydration.
    if (isStringMode())
    {
        return wrapContents('suspense', serializeChild(props.fallback())) as unknown as HTMLElement;
    }

    // Memo collapses N loading getters into one boolean. Show
    // re-evaluates `when` on signal change; the memo's structural
    // equality means Show's effect only re-runs when the answer
    // genuinely flips, not on every loading-state ripple.
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

    // Delegate the actual swap to Show: proven, leak-tested, and already does
    // per-branch createRoot ownership and destroyComponent on swap.
    return Show({
        when: () => !anyLoading(),
        fallback: props.fallback,
        children: props.children
    });
}
