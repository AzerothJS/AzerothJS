/**
 * MODULE: reactivity/on-root-dispose
 *
 * onRootDispose() registers a callback that runs exactly once, when the surrounding
 * createRoot() is disposed. It is the scope-level sibling of onCleanup:
 *   - onCleanup(fn) lives inside an effect, fires before each re-run and on dispose,
 *     and is for per-run resource teardown (timers, listeners).
 *   - onRootDispose(fn) lives inside a root, fires only on scope teardown, and is for
 *     state that outlives any single effect run.
 *
 * It exists because some state is accumulated ACROSS many runs of one effect - the
 * renderer's <For> keeps per-key effects/components/DOM nodes - and must be torn down
 * only when the scope unmounts, never on an effect re-run. onCleanup cannot express
 * that; the same need appears for a router's popstate listener or store subscriptions.
 */

import { registerDisposer } from './create-root.ts';

/**
 * onRootDispose
 *
 * PURPOSE:
 * Registers a callback to run once when the enclosing createRoot() is disposed.
 *
 * WHY IT EXISTS:
 * onCleanup fires on every effect re-run, which is wrong for resources accumulated
 * across runs that should be released only when the whole scope unmounts. Tying such
 * teardown to an effect's run cycle either drops state too early or requires a cryptic
 * empty-deps "sentinel effect"; onRootDispose names the intent directly.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity lifetime. Used by higher layers (the renderer's <For>, the
 * router, stores) to attach scope-lifetime teardown; it simply appends to the active
 * root's disposer list.
 *
 * INPUT CONTRACT:
 * - fn: the teardown callback. Must be called synchronously inside a createRoot() to
 *   attach to that root.
 *
 * OUTPUT CONTRACT:
 * - Returns void. The callback runs exactly once, when the root is disposed. Called
 *   outside any root it is a safe no-op (the callback is discarded).
 *
 * WHY THIS DESIGN:
 * It delegates to registerDisposer, so root-disposal callbacks share the root's LIFO
 * disposer list with effect/memo disposers - one teardown order, one mechanism. The
 * no-op-outside-root rule mirrors onCleanup's no-op-outside-effect for symmetry.
 *
 * WHEN TO USE:
 * For resources whose lifetime is the scope, not a single effect run: global listeners,
 * per-key maps built across runs, external subscriptions.
 *
 * WHEN NOT TO USE:
 * For per-run teardown (use onCleanup). Outside a root (it does nothing there).
 *
 * EDGE CASES:
 * - Fires in LIFO order with the rest of the root's disposers (reverse of registration).
 * - Outside a createRoot() it silently drops the callback rather than throwing.
 *
 * PERFORMANCE NOTES:
 * O(1): a single push onto the active root's disposer list.
 *
 * DEVELOPER WARNING:
 * The callback runs once and only on root disposal - do not use it for teardown that
 * must repeat per effect run, and ensure a root is actually active or it is dropped.
 *
 * @param fn - The function to run on root disposal.
 * @returns void
 * @see {@link createRoot}
 * @see {@link onCleanup}
 * @example
 * createRoot((dispose) => {
 *     const handler = () => console.log('scrolled');
 *     window.addEventListener('scroll', handler);
 *     onRootDispose(() => window.removeEventListener('scroll', handler));
 *     // dispose() later removes the listener exactly once
 * });
 */
export function onRootDispose(fn: () => void): void
{
    // registerDisposer appends to the active root's disposer list when one is present
    // and no-ops otherwise - exactly the contract we want.
    registerDisposer(fn);
}
