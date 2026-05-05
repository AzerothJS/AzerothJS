// ============================================================================
// AZEROTHJS — Reactivity Public API
// ============================================================================
//
// EXPORTED (public):
//   createSignal()  — Reactive state (getter/setter pair)
//   createEffect()  — Reactive side effects (auto re-run)
//   createMemo()    — Cached computed values
//   batch()         — Grouped signal updates (single flush)
//   untrack()       — Read signals without subscribing
//   on()            — Explicit dependency tracking
//   onCleanup()     — Imperative cleanup inside effects
//   onRootDispose() — Imperative cleanup tied to a createRoot scope
//   createRoot()    — Isolated reactive ownership scope
//   createDeferred() — Debounced reactive value
//   createSelector() — Efficient selection tracking for lists
//   createResource() — Async fetcher → reactive data/loading/error
//   createStream()  — Streaming fetcher → reactive partial/done/error
//   catchError()    — Route reactive errors to a handler
//
// NOT EXPORTED (internal):
//   currentSubscriber   — Used by signal/effect wiring
//   setCurrentSubscriber — Used by effect/untrack
//   isBatching          — Used by effect
//   queueEffect         — Used by effect
//
// ============================================================================

export { createSignal } from './signal.ts';
export { createEffect } from './effect.ts';
export { createMemo } from './memo.ts';
export { batch } from './batch.ts';
export { untrack } from './untrack.ts';
export { on } from './on.ts';
export { onCleanup } from './on-cleanup.ts';
export { onRootDispose } from './on-root-dispose.ts';
export { createRoot } from './create-root.ts';
export { createDeferred } from './create-deferred.ts';
export { createSelector } from './create-selector.ts';
export { createResource } from './create-resource.ts';
export { createStream } from './create-stream.ts';
export { catchError } from './catch-error.ts';

export type { Resource } from './create-resource.ts';
export type { Stream, StreamOptions, StreamParseMode } from './create-stream.ts';

export type {
    CleanupFn,
    Getter,
    Setter,
    Signal,
    Subscriber,
    EffectFn,
    DisposeFn,
    EqualsFn,
    SignalOptions,
    EffectOptions
} from './types.ts';
