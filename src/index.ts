// ============================================================================
// QUANTUM FRAMEWORK — Main Entry Point
// ============================================================================
//
// This is the root entry point of the Quantum framework.
// Everything a user can import from 'quantumjs' comes from here.
//
// CURRENT MODULES:
//   ✅ Reactivity — Signals, Effects, Memos, Batch
//   ✅ Renderer   — h(), render() — Direct DOM, no Virtual DOM
//   ✅ Component  — defineComponent(), lifecycle hooks
//
// FUTURE MODULES (will be added as we build them):
//   ⬜ Router     — createRouter(), Link, SPA navigation
//   ⬜ Store      — Global state management
//   ⬜ Stream     — AI streaming primitives
//
// USAGE:
//   import {
//     createSignal, createEffect, createMemo, batch,
//     h, render,
//     defineComponent, onMount, onDestroy,
//   } from 'quantumjs';
//
// ============================================================================

// ── Reactivity ───────────────────────────────────────────────────────────────
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

// ── Renderer ─────────────────────────────────────────────────────────────────
export {
    // ── Functions ──
    h,
    render,

    // ── Types ──
    type Props,
    type Child,
} from './renderer/index.ts';

// ── Component ────────────────────────────────────────────────────────────────
export {
    // ── Functions ──
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,

    // ── Types ──
    type Component,
    type ComponentSetup,
    type LifecycleHook,
} from './component/index.ts';
