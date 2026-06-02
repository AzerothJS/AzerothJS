// Public API for @azerothjs/component.
//
//   defineComponent()   - create function components with lifecycle hooks
//   AzerothComponent    - base class for class-based components
//   onMount/onDestroy   - lifecycle hooks for function components
//   destroyComponent()  - trigger cleanup on any component
//   ErrorBoundary       - catch errors in a subtree, render a fallback

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
