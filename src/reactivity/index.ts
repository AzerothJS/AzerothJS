// ============================================================================
// QUANTUM FRAMEWORK — Reactivity Public API
// ============================================================================
//
// EXPORTED (public):
//   createSignal()  — Reactive state
//   createEffect()  — Reactive side effects
//   createMemo()    — Cached computed values
//   batch()         — Grouped signal updates
//   untrack()       — Read signals without subscribing
//   on()            — Explicit dependency tracking
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
