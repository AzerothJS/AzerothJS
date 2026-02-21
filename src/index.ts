// ============================================================================
// QUANTUM FRAMEWORK — Main Entry Point
// ============================================================================
//
// CURRENT MODULES:
//   ✅ Reactivity — Signals, Effects, Memos, Batch, Untrack, On
//   ✅ Renderer   — h(), render() — Direct DOM, no Virtual DOM
//   ✅ Component  — defineComponent(), lifecycle hooks
//
// ============================================================================

// ── Reactivity ───────────────────────────────────────────────────────────────

export {
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,

    type CleanupFn,
    type Getter,
    type Setter,
    type Signal,
    type Subscriber,
    type EffectFn,
    type DisposeFn,
    type EqualsFn,
    type SignalOptions,
    type EffectOptions
} from './reactivity/index.ts';

// ── Renderer ─────────────────────────────────────────────────────────────────

export {
    h,
    render,

    type Props,
    type Child
} from './renderer/index.ts';

// ── Component ────────────────────────────────────────────────────────────────

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,

    type Component,
    type ComponentSetup,
    type LifecycleHook
} from './component/index.ts';
