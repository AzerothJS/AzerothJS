/**
 * MODULE: reactivity/on-mount
 *
 * The sanctioned post-connection hook. Effects run DURING construction and `ref` fires
 * before the element is inserted, so measuring layout or initializing a third-party
 * widget from either observes a detached node. Every insertion path in this framework
 * is synchronous (render() appends, hydrate() adopts, control-flow branches splice
 * within one effect run), so deferring one microtask is a complete "after connection"
 * guarantee - onMount packages that deferral WITH ownership: the callback runs under
 * the owner that registered it (effects it creates are owned, context resolves, errors
 * route to the owner's boundary), it is SKIPPED if that owner was disposed first (a
 * branch that swapped away before the microtask), and a returned cleanup is registered
 * as the owner's disposer.
 */

import { getOwner, runWithOwner, registerDisposer } from './create-root.ts';
import { isStringMode } from './render-mode.ts';
import { assertFunction } from './validate.ts';

/**
 * onMount
 *
 * PURPOSE:
 * Runs `fn` once, after the current synchronous render/insertion completes - the
 * earliest moment the constructed DOM is connected - under the registering owner.
 *
 * WHY IT EXISTS:
 * Construction-time code (effects, refs) sees detached nodes: layout reads return
 * zeros and widget libraries that require a connected element misbehave. Teams
 * otherwise reinvent `queueMicrotask` by hand - unowned, running even when the scope
 * already unmounted, with nowhere to hang teardown. onMount is that deferral made
 * safe.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity lifetimes. Called during component/root setup; the callback runs
 * one microtask later via {@link runWithOwner}, so ownership, context, and error
 * routing behave exactly as they would have synchronously.
 *
 * INPUT CONTRACT:
 * - fn: runs once post-connection. It may return a cleanup function.
 *
 * OUTPUT CONTRACT:
 * - Returns void. A cleanup returned by fn is registered with the owner and runs on
 *   dispose (unmount). With no owner at registration, the callback still runs but a
 *   returned cleanup has nowhere to register - it is dropped (matching onCleanup's
 *   no-op-outside-a-scope contract).
 *
 * WHY THIS DESIGN:
 * A microtask (not a MutationObserver) because insertion here is ALWAYS synchronous -
 * by the first microtask the subtree is connected on every path (render, hydrate,
 * control-flow swap). Owner-gating handles the swap-away race: a branch built and
 * discarded within one run never fires its onMount.
 *
 * WHEN TO USE:
 * Measuring layout, focusing, initializing non-reactive widgets (maps, charts,
 * editors) that need a CONNECTED element.
 *
 * WHEN NOT TO USE:
 * For reactive work - use createEffect (it tracks). For teardown alone - use
 * onRootDispose. Not a "component did render" notification: it fires once per
 * registration, not per update.
 *
 * EDGE CASES:
 * - SSR ('string' mode): never runs - the server renders once and mounts nothing.
 * - Owner disposed before the microtask: fn is skipped entirely.
 * - Multiple onMount calls run in registration order (microtask FIFO).
 *
 * PERFORMANCE NOTES:
 * One queueMicrotask per call; nothing retained after it fires (or is skipped).
 *
 * DEVELOPER WARNING:
 * The DOM is connected but the browser has NOT painted yet - a microtask precedes
 * frame rendering. For after-paint work, chain a requestAnimationFrame inside.
 *
 * @param fn - Runs once post-connection; may return a cleanup registered on the owner.
 * @returns void
 * @see {@link onRootDispose}
 * @example
 * export default component Chart
 * {
 *     let host!: HTMLDivElement;
 *     onMount(() =>
 *     {
 *         const chart = createChart(host, options); // host is connected here
 *         return () => chart.destroy();             // runs on unmount
 *     });
 *     <div ref={ (el) => host = el } class="chart-host"></div>
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps a bare no-cleanup callback assignable (same contract as guard())
export function onMount(fn: () => void | (() => void)): void
{
    assertFunction(fn, 'onMount', 'Pass the post-connection work as a function: onMount(() => { ... }).');

    if (isStringMode())
    {
        return; // SSR renders once and mounts nothing - the hook is client-only.
    }

    const owner = getOwner();
    queueMicrotask(() =>
    {
        if (owner !== null && owner.disposed)
        {
            return; // the scope unmounted before the microtask - never fire.
        }
        runWithOwner(owner, () =>
        {
            const cleanup = fn();
            if (typeof cleanup === 'function')
            {
                registerDisposer(cleanup);
            }
        });
    });
}
