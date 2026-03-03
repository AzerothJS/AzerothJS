// ============================================================================
// QUANTUM FRAMEWORK — Reactivity Public API
// ============================================================================
//
// EXPORTED (public):
//   createSignal()  — Reactive state (getter/setter pair)
//   createEffect()  — Reactive side effects (auto re-run)
//   createMemo()    — Cached computed values
//   batch()         — Grouped signal updates (single flush)
//   untrack()       — Read signals without subscribing
//   on()            — Explicit dependency tracking
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
