// ============================================================================
// QUANTUM FRAMEWORK — Main Entry Point
// ============================================================================
//
// CURRENT MODULES:
//   ✅ Reactivity — Signals, Effects, Memos, Batch, Untrack, On
//   ✅ Renderer   — h(), render(), Show, For, Switch, Portal, Ref
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
    Show,
    For,
    Switch,
    Match,
    Portal,
    destroyPortal,
    createRef,

    type Props,
    type Child,
    type ShowProps,
    type ForProps,
    type MatchCase,
    type PortalProps,
    type Ref
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
