// onRootDispose() registers a callback that runs exactly once, when the
// surrounding createRoot() is disposed. Unlike onCleanup it is not tied to an
// effect, so it fires only on scope teardown, not on every effect re-run.
//
// Sibling to onCleanup:
//   - onCleanup(fn) is called inside a createEffect(), fires before each
//     re-run and on dispose, and is for per-run resource teardown (timers,
//     listeners).
//   - onRootDispose(fn) is called inside a createRoot(), fires only when the
//     root is disposed, and is for per-scope teardown of resources that
//     outlive any single effect.
//
// Why a separate primitive: the renderer's <For> accumulates per-key state
// (effects, components, DOM nodes) across many runs of one effect. That state
// must NOT be torn down when the effect re-runs - that would drop items we
// still need - only when the surrounding root unmounts. onCleanup can't
// express this; the previous workaround was a cryptic "sentinel effect with
// empty deps". The same need shows up elsewhere, e.g. detaching a router's
// popstate listener or cancelling store subscriptions on scope teardown.
//
// It works by registering `fn` with the current root's disposer list;
// createRoot() runs every disposer in LIFO order on dispose. Called outside a
// root it is a silent no-op (matching onCleanup outside an effect) - the
// callback is dropped, no error.

import { registerDisposer } from './create-root.ts';

/**
 * Registers a callback to run when the current `createRoot()` is
 * disposed.
 *
 * Use this for cleanup that must outlive any single effect's run
 * cycle: things you accumulated across many effect re-runs and
 * only want to tear down once, when the whole scope unmounts.
 *
 * The callback fires exactly once. Calling `onRootDispose` outside a
 * `createRoot()` is a safe no-op - the callback is silently discarded.
 *
 * @param fn - The function to run on root disposal
 *
 * Why: onCleanup fires on every effect re-run, which is wrong for state that is
 * accumulated across runs and should be torn down only when the scope unmounts.
 *
 * Without onRootDispose: an effect's onCleanup tears state down too eagerly:
 *
 *     createEffect(() =>
 *     {
 *         items.set(key(), entry);
 *         onCleanup(() => items.clear()); // wipes the map on every re-run
 *     });
 *
 * With onRootDispose: teardown runs once, when the root is disposed:
 *
 *     createRoot(() =>
 *     {
 *         createEffect(() => items.set(key(), entry));
 *         onRootDispose(() => items.clear()); // fires only on scope unmount
 *     });
 *
 * @example
 * ```ts
 * // Wire up a global listener for the lifetime of a scope
 * createRoot((dispose) =>
 * {
 *     const handler = () => console.log('scrolled');
 *     window.addEventListener('scroll', handler);
 *     onRootDispose(() => window.removeEventListener('scroll', handler));
 *     // later, dispose() removes the listener exactly once
 * });
 * ```
 *
 * @example
 * ```ts
 * // Callbacks fire in LIFO order (reverse of registration), the same
 * // order createRoot() unwinds its disposers.
 * createRoot((dispose) =>
 * {
 *     onRootDispose(() => console.log('A'));
 *     onRootDispose(() => console.log('B'));
 *     onRootDispose(() => console.log('C'));
 *     dispose(); // prints C, B, A
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
 *         // add/remove entries from `items` based on signals.
 *         // Do NOT clear the map here - that would lose state.
 *     });
 *
 *     onRootDispose(() =>
 *     {
 *         for (const entry of items.values()) entry.dispose();
 *         items.clear();
 *     });
 * });
 * ```
 */
export function onRootDispose(fn: () => void): void
{
    // registerDisposer appends to the active root's disposer list when one is
    // present and no-ops otherwise - exactly the contract we want.
    registerDisposer(fn);
}
