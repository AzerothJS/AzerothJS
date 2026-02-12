// ============================================================================
// QUANTUM FRAMEWORK — Reactivity Public API
// ============================================================================
//
// This is the barrel file for the reactivity system.
// It re-exports only the PUBLIC API — the functions and types that
// framework users should interact with.
//
// WHAT IS A BARREL FILE?
//   A barrel file collects exports from multiple files and
//   re-exports them from a single entry point. This way, users
//   import from one place instead of digging through internal files:
//
//   WITHOUT barrel file (users must know internal file structure):
//     import { createSignal } from 'quantumjs/reactivity/signal';
//     import { createEffect } from 'quantumjs/reactivity/effect';
//     import { createMemo } from 'quantumjs/reactivity/memo';
//     import { batch } from 'quantumjs/reactivity/batch';
//
//   WITH barrel file (users import from one clean path):
//     import { createSignal, createEffect, createMemo, batch } from 'quantumjs';
//
// WHAT WE EXPORT vs WHAT WE HIDE:
//
//   ✅ EXPORTED (public — users use these):
//     createSignal  — Create reactive state
//     createEffect  — React to state changes
//     createMemo    — Derive computed values
//     batch         — Group multiple updates
//     All types     — For TypeScript users
//
//   ❌ HIDDEN (internal — users should never touch these):
//     getCurrentEffect  — Internal tracking mechanism
//     setCurrentEffect  — Internal tracking mechanism
//     getIsBatching     — Internal batch state check
//     enqueueEffect     — Internal batch queue management
//
//   Why hide them?
//     These are implementation details. If users call them directly,
//     they could break the reactivity system. By not exporting them,
//     we make it impossible to misuse them.
//
// ============================================================================

// ── Functions ────────────────────────────────────────────────────────────────

export { createSignal } from './signal.ts';
export { createEffect } from './effect.ts';
export { createMemo } from './memo.ts';
export { batch } from './batch.ts';

// ── Types ────────────────────────────────────────────────────────────────────

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
    EffectOptions,
} from './types.ts';
