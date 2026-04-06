// ============================================================================
// QUANTUM FRAMEWORK — Main Entry Point
// ============================================================================
//
// THREE WAYS TO BUILD COMPONENTS:
//   ✅ Function:  defineComponent((props) => h(...))
//   ✅ Class:     class MyComp extends QuantumComponent { render() {...} }
//   🔜 SFC:       .quantum files (coming soon)
//
// API CONSISTENCY:
//   Function:  createSignal, createEffect, createMemo, onMount, onDestroy, onCleanup
//   Class:     this.createSignal, this.createEffect, this.createMemo,
//              onMount(), onDestroy()
//   Standalone: batch, untrack, on, onCleanup, createRoot — work everywhere, just import
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
    onCleanup,
    createRoot,
    createDeferred,
    createSelector
} from './reactivity/index.ts';

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
    Dynamic,
    createRef,
    classList,
    styleMap
} from './renderer/index.ts';

export type {
    Props,
    Child,
    ShowProps,
    ForProps,
    MatchCase,
    PortalProps,
    DynamicProps,
    Ref,
    ClassObject,
    StyleObject
} from './renderer/index.ts';

// ── Component ───────────────────────────────────────────────────────────────

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,
    QuantumComponent
} from './component/index.ts';

export type {
    Component,
    ComponentSetup,
    LifecycleHook,
    ReactiveState
} from './component/index.ts';
