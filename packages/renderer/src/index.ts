// ============================================================================
// AZEROTHJS — Renderer Public API
// ============================================================================
//
// EXPORTED (public):
//   h()             — Create real DOM elements
//   render()        — Mount component tree to DOM
//   Show()          — Conditional rendering
//   For()           — Keyed list rendering
//   Switch()        — Multi-condition rendering
//   Match()         — Single case for Switch
//   Portal()        — Render outside parent DOM
//   destroyPortal() — Clean up portaled content
//   Dynamic()       — Swap components at runtime
//   Suspense()      — Show fallback while resources are loading
//   Transition()    — Animate enter/leave with CSS class families
//   createRef()     — Direct DOM element access
//   classList()     — Reactive CSS class binding
//   styleMap()      — Reactive inline style binding
//
// ============================================================================

export { h } from './h.ts';
export { render } from './render.ts';
export { Show } from './show.ts';
export { For } from './for.ts';
export { Switch, Match } from './switch.ts';
export { Portal, destroyPortal } from './portal.ts';
export { Dynamic } from './dynamic.ts';
export { Suspense } from './suspense.ts';
export { Transition } from './transition.ts';
export { createRef } from './ref.ts';
export { classList } from './class-binding.ts';
export { styleMap } from './style-binding.ts';

export type { Props, Child } from './types.ts';
export type { ShowProps } from './show.ts';
export type { ForProps } from './for.ts';
export type { MatchCase } from './switch.ts';
export type { PortalProps } from './portal.ts';
export type { DynamicProps } from './dynamic.ts';
export type { SuspenseProps } from './suspense.ts';
export type { TransitionProps } from './transition.ts';
export type { Ref } from './ref.ts';
export type { ClassObject } from './class-binding.ts';
export type { StyleObject } from './style-binding.ts';
