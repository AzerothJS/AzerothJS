// ============================================================================
// AZEROTHJS — @azerothjs/core (Umbrella Package)
// ============================================================================
//
// Re-exports everything from @azerothjs/reactivity, @azerothjs/renderer,
// and @azerothjs/component so users can install a single package:
//
//   import { createSignal, h, defineComponent } from '@azerothjs/core';
//
// Or import individual packages for tree-shaking:
//
//   import { createSignal } from '@azerothjs/reactivity';
//   import { h } from '@azerothjs/renderer';
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
    onRootDispose,
    createRoot,
    createDeferred,
    createSelector,
    createResource,
    catchError
} from '@azerothjs/reactivity';

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
    Resource
} from '@azerothjs/reactivity';

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
    Suspense,
    createRef,
    classList,
    styleMap
} from '@azerothjs/renderer';

export type {
    Props,
    Child,
    ShowProps,
    ForProps,
    MatchCase,
    PortalProps,
    DynamicProps,
    SuspenseProps,
    Ref,
    ClassObject,
    StyleObject
} from '@azerothjs/renderer';

// ── Component ───────────────────────────────────────────────────────────────

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,
    AzerothComponent,
    ErrorBoundary
} from '@azerothjs/component';

export type {
    Component,
    ComponentSetup,
    LifecycleHook,
    ReactiveState,
    ErrorBoundaryProps
} from '@azerothjs/component';

// ── Store ───────────────────────────────────────────────────────────────────

export { createStore } from '@azerothjs/store';
