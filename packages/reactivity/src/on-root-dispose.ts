// ============================================================================
// AZEROTHJS — onRootDispose (Per-Scope Cleanup Hook)
// ============================================================================
//
// onRootDispose() registers a callback that runs exactly once,
// when the surrounding createRoot() is disposed. Unlike onCleanup,
// it is NOT tied to an effect — it fires only on scope teardown,
// not on every effect re-run.
//
// SIBLING TO onCleanup:
//
//   onCleanup(fn)
//     - Must be called inside a createEffect()
//     - Fires BEFORE the effect re-runs AND on dispose
//     - Used for per-run resource teardown (timers, listeners, …)
//
//   onRootDispose(fn)
//     - Must be called inside a createRoot()
//     - Fires ONLY when the root is disposed
//     - Used for per-scope teardown (collected resources that
//       outlive any single effect)
//
// WHY DOES THIS NEED ITS OWN PRIMITIVE?
//
//   The renderer's <For> component accumulates per-key state
//   (effects, components, DOM nodes) across many runs of a single
//   effect. The cleanup of that state must NOT run when the effect
//   re-runs — that would tear down items we still need. It MUST
//   run when the surrounding root unmounts. onCleanup can't express
//   this; we previously used a "sentinel effect with empty deps"
//   trick, which works but is cryptic.
//
//   The same need will come up in Phase 3:
//     - Router: detach the popstate listener when the router
//       scope unmounts (not when the route effect re-runs)
//     - Store: cancel subscriptions on scope teardown
//
// HOW IT WORKS:
//
//   onRootDispose(fn) simply registers `fn` with the current root's
//   disposer list. createRoot() runs every disposer (in LIFO order)
//   when its dispose callback is invoked.
//
//   Called outside a root: silent no-op (matching onCleanup's
//   behavior outside an effect). The callback is dropped — caller
//   gets no error.
//
// ============================================================================

import { registerDisposer } from './create-root.ts';

/**
 * Registers a callback to run when the current `createRoot()` is
 * disposed.
 *
 * Use this for cleanup that must outlive any single effect's run
 * cycle: things you accumulated across many effect re-runs and
 * only want to tear down once, when the whole scope unmounts.
 *
 * The callback fires exactly once. Calling `onRootDispose` outside
 * of a `createRoot()` is a safe no-op — the callback is silently
 * discarded.
 *
 * @param fn - The function to run on root disposal
 *
 * @example
 * ```ts
 * // Wire up a global listener for the lifetime of a scope
 * createRoot((dispose) =>
 * {
 *     const handler = () => console.log('scrolled');
 *     window.addEventListener('scroll', handler);
 *
 *     onRootDispose(() =>
 *     {
 *         window.removeEventListener('scroll', handler);
 *     });
 *
 *     // …later, dispose() removes the listener exactly once.
 * });
 * ```
 *
 * @example
 * ```ts
 * // Tear down a per-key map accumulated across many effect runs
 * createRoot(() =>
 * {
 *     const items = new Map<string, ItemEntry>();
 *
 *     createEffect(() =>
 *     {
 *         // … add/remove entries from `items` based on signals.
 *         // Do NOT clear the map here — that would lose state.
 *     });
 *
 *     onRootDispose(() =>
 *     {
 *         for (const entry of items.values()) entry.dispose();
 *         items.clear();
 *     });
 * });
 * ```
 *
 * @example
 * ```ts
 * // Multiple onRootDispose calls all fire, in LIFO order
 * createRoot((dispose) =>
 * {
 *     onRootDispose(() => console.log('A'));
 *     onRootDispose(() => console.log('B'));
 *     onRootDispose(() => console.log('C'));
 *
 *     dispose();
 *     // Prints: C, B, A
 * });
 * ```
 *
 * @example
 * ```ts
 * // Outside a root: safe no-op
 * onRootDispose(() => console.log('never runs'));
 * ```
 */
export function onRootDispose(fn: () => void): void
{
    // The current root's disposer array (or null) is managed by
    // createRoot(). registerDisposer() appends to it when present
    // and silently no-ops otherwise — exactly the contract we want.
    registerDisposer(fn);
}
