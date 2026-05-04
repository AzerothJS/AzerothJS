// ============================================================================
// AZEROTHJS — Component Public API
// ============================================================================
//
// EXPORTED (public):
//   defineComponent()    — Create function components with lifecycle
//   AzerothComponent     — Base class for class-based components
//   onMount()            — Mount lifecycle hook (function components)
//   onDestroy()          — Destroy lifecycle hook (function components)
//   destroyComponent()   — Trigger cleanup on any component
//   ErrorBoundary        — Catch errors in a subtree, render fallback
//
// ============================================================================

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy
} from './define-component.ts';

export { AzerothComponent } from './azeroth-component.ts';
export type { ReactiveState } from './azeroth-component.ts';

export { ErrorBoundary } from './error-boundary.ts';
export type { ErrorBoundaryProps } from './error-boundary.ts';

export type {
    Component,
    ComponentSetup,
    LifecycleHook
} from './types.ts';
