/**
 * Scope-lifetime teardown, the sibling of onCleanup. onCleanup fires before every effect
 * re-run; onRootDispose fires only when the surrounding scope is disposed.
 *
 * The distinction matters for state accumulated ACROSS many runs of one effect - the
 * renderer's `<For>` holds per-key effects, components and DOM nodes - which must survive
 * re-runs and die only at unmount. The same need shows up for a router's popstate listener
 * and for store subscriptions.
 */

import { registerDisposer } from './create-root.ts';

/**
 * Registers a callback that runs exactly once, when the enclosing scope is disposed, in
 * LIFO order with the scope's other disposers.
 *
 * Must be called synchronously inside the scope. Outside every scope the callback is
 * silently dropped rather than throwing, so code that may run either inside or outside one
 * stays safe.
 *
 * @param fn - Teardown to run at scope disposal.
 * @example
 * createRoot((dispose) =>
 * {
 *     const onScroll = () => track(window.scrollY);
 *     window.addEventListener('scroll', onScroll);
 *     onRootDispose(() => window.removeEventListener('scroll', onScroll));
 * });
 *
 * @see {@link onCleanup} for per-run teardown.
 * @see {@link createRoot}
 */
export function onRootDispose(fn: () => void): void
{
    registerDisposer(fn);
}
