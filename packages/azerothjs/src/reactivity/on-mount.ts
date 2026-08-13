/**
 * The post-connection hook. Effects run DURING construction and `ref` fires before the
 * element is inserted, so measuring layout or initializing a third-party widget from either
 * one observes a detached node.
 *
 * Every insertion path here is synchronous - render() appends, hydrate() adopts, a
 * control-flow branch splices within one effect run - so deferring by a single microtask is
 * a complete "after connection" guarantee. What onMount adds to that deferral is ownership:
 * the callback runs under the owner that registered it, is skipped entirely if that owner
 * was disposed first, and a returned cleanup becomes the owner's disposer.
 */

import { getOwner, runWithOwner, registerDisposer } from './create-root.ts';
import { isStringMode } from './render-mode.ts';
import { assertFunction } from './validate.ts';

/**
 * Runs `fn` once, one microtask after the current synchronous render or insertion - the
 * earliest moment the constructed DOM is connected - under the owner that registered it.
 *
 * The node is connected by then, but the browser has NOT painted: a microtask runs before
 * the next frame. Chain a requestAnimationFrame inside for after-paint work.
 *
 * It fires once per registration, not once per update, so it is not a "component rendered"
 * notification. Several onMount calls run in registration order.
 *
 * If the owner is disposed before the microtask - a branch that swapped away in the same
 * run - `fn` never runs at all. A cleanup returned by `fn` is registered with that owner
 * and runs on unmount; registered with no owner at all, the callback still runs but the
 * cleanup has nowhere to attach and is dropped.
 *
 * Never runs during SSR: the server renders once and mounts nothing.
 *
 * @param fn - Post-connection work. May return a cleanup.
 * @throws {TypeError} If `fn` is not a function.
 * @example
 * export default component Chart
 * {
 *     let host!: HTMLDivElement;
 *
 *     onMount(() =>
 *     {
 *         const chart = createChart(host, options); // host is connected here
 *         return () => chart.destroy();             // runs on unmount
 *     });
 *
 *     <div ref={ (el) => host = el } class="chart-host"></div>
 * }
 *
 * @see {@link createEffect} for work that must react to state.
 * @see {@link onRootDispose} for teardown alone.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void keeps a bare no-cleanup callback assignable (same contract as guard())
export function onMount(fn: () => void | (() => void)): void
{
    assertFunction(fn, 'onMount', 'Pass the post-connection work as a function: onMount(() => { ... }).');

    if (isStringMode())
    {
        return;
    }

    const owner = getOwner();
    queueMicrotask(() =>
    {
        if (owner !== null && owner.disposed)
        {
            return; // the scope unmounted before the microtask
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
