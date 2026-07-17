/**
 * MODULE: compiler/markers - intermediate marker identifiers for nested-scope reactive lowering
 *
 * The `state`/`derived`/`effect` keywords lower to `createSignal`/`createMemo`/`createEffect`. At the
 * component-body top level codegen emits those calls directly. INSIDE a nested scope (a render
 * callback, an IIFE, a helper or module-level "composable" function) the lowering instead rewrites the
 * keyword to one of these MARKER calls first, so the shared reactive walk (walk.ts) can tell a
 * keyword-lowered binding (whose reads are bare and must gain `()`) apart from a hand-written
 * `createMemo`/`createSignal` (whose reads are already called). After the read/write rewrite runs, the
 * markers are stripped back to the real runtime calls (lower-reactive.ts).
 *
 * They are deliberately unusual identifiers so they never collide with user code, and they exist only
 * transiently between the lowering's transform and strip steps - they never appear in emitted output.
 *
 * @internal
 */

// These three mark SOURCE-introducing declarations, so the reactive walk (walk.ts) can recognise the
// lowered binding as a scoped source (its bare reads gain `()`). Non-source blocks (the `effect` forms -
// AST kinds `effect` and `watch` - and the block-wrappers) don't need walk recognition; the lowering
// emits their runtime call directly.

/** Marker for a `derived` lowered inside a nested scope (becomes `createMemo`). */
export const MARKER_MEMO = '__azMemo';

/** Marker for a `state` lowered inside a nested scope (becomes `createSignal`). */
export const MARKER_SIGNAL = '__azSignal';

/** Marker for a `deferred` lowered inside a nested scope (becomes `createDeferred`). */
export const MARKER_DEFERRED = '__azDeferred';
