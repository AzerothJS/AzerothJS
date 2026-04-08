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

export type {
    Component,
    ComponentSetup,
    LifecycleHook
} from './types.ts';
