// ============================================================================
// QUANTUM FRAMEWORK — Component Public API
// ============================================================================
//
// EXPORTED (public):
//   defineComponent()  — Create a reusable component with lifecycle
//   destroyComponent() — Run cleanup hooks when removing a component
//   onMount()          — Register a callback for when component is created
//   onDestroy()        — Register a callback for when component is destroyed
//
// HIDDEN (internal):
//   getCurrentLifecycle() — Internal lifecycle context getter
//   setCurrentLifecycle() — Internal lifecycle context setter
//
// ============================================================================

export { defineComponent, destroyComponent } from './define-component.ts';
export { onMount, onDestroy } from './lifecycle.ts';

export type {
    Component,
    ComponentSetup,
    LifecycleHook,
} from './types.ts';
