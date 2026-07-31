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

/**
 * Marker wrapping a `<For>` render-fn child emitted in RAW mode (markup embedded in an
 * expression), where the read/write rewrite is deferred to the enclosing pass. The wrap carries
 * what the emitting IR knew - "this arrow's params are row-item getters read as values" -
 * through the text boundary: the walk scopes the wrapped arrow's params as row items and the
 * rewrite strips the wrapper. Recognition by this reserved name (never by `For`, which is
 * PUBLIC manual API a user may legitimately call with getter-style reads) is what keeps the
 * row rewrite from ever touching hand-written code.
 */
export const MARKER_ROW = '__azRow';
