// ============================================================================
// QUANTUM FRAMEWORK — Renderer Public API
// ============================================================================
//
// EXPORTED (public):
//   h()           — Create real DOM elements
//   render()      — Mount component tree to DOM
//   Show()        — Conditional rendering
//   For()         — Keyed list rendering
//   Switch()      — Multi-condition rendering
//   Match()       — Single case for Switch
//   Portal()      — Render outside parent DOM
//   destroyPortal() — Clean up portaled content
//   createRef()   — Direct DOM element access
//
// ============================================================================

export { h } from './h.ts';
export { render } from './render.ts';
export { Show } from './show.ts';
export { For } from './for.ts';
export { Switch, Match } from './switch.ts';
export { Portal, destroyPortal } from './portal.ts';
export { createRef } from './ref.ts';

export type { Props, Child } from './types.ts';
export type { ShowProps } from './show.ts';
export type { ForProps } from './for.ts';
export type { MatchCase } from './switch.ts';
export type { PortalProps } from './portal.ts';
export type { Ref } from './ref.ts';
