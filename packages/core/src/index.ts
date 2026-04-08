// ============================================================================
// QUANTUM FRAMEWORK — @quantum/core (Umbrella Package)
// ============================================================================
//
// Re-exports everything from @quantum/reactivity, @quantum/renderer,
// and @quantum/component so users can install a single package:
//
//   import { createSignal, h, defineComponent } from '@quantum/core';
//
// Or import individual packages for tree-shaking:
//
//   import { createSignal } from '@quantum/reactivity';
//   import { h } from '@quantum/renderer';
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
} from '@quantum/reactivity';

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
} from '@quantum/reactivity';

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
} from '@quantum/renderer';

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
} from '@quantum/renderer';

// ── Component ───────────────────────────────────────────────────────────────

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,
    QuantumComponent
} from '@quantum/component';

export type {
    Component,
    ComponentSetup,
    LifecycleHook,
    ReactiveState
} from '@quantum/component';

