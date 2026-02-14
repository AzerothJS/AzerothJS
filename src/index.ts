// ============================================================================
// QUANTUM FRAMEWORK — Main Entry Point
// ============================================================================
//
// This is the root entry point of the Quantum framework.
// Everything a user can import from 'quantumjs' comes from here.
//
// CURRENT MODULES:
//   ✅ Reactivity — Signals, Effects, Memos, Batch
//
// FUTURE MODULES (will be added as we build them):
//   ✅ Renderer   — DOM rendering engine
//   ⬜ Component  — Component system (.quantum files)
//   ⬜ Router     — File-based and code-based routing
//   ⬜ Store      — Global state management
//   ⬜ Stream     — AI streaming primitives
//
// USAGE:
//   import { createSignal, createEffect, createMemo, batch } from 'quantumjs';
//
// ============================================================================

export {
    // ── Functions ──
    createSignal,
    createEffect,
    createMemo,
    batch,

    // ── Types ──
    type CleanupFn,
    type Getter,
    type Setter,
    type Signal,
    type Subscriber,
    type EffectFn,
    type DisposeFn,
    type EqualsFn,
    type SignalOptions,
    type EffectOptions,
} from './reactivity/index.ts';

export {
    // ── Functions ──
    h,
    render,

    // ── Types ──
    type Props,
    type Child,
} from './renderer/index.ts';
