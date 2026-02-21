// ============================================================================
// QUANTUM FRAMEWORK — Renderer Public API
// ============================================================================
//
// Quantum's renderer creates REAL DOM elements directly — no virtual DOM.
//
// EXPORTED (public):
//   h()      — Creates real DOM elements with reactive bindings
//   render() — Mounts an element tree into a DOM container
//
// ============================================================================

export { h } from './h.ts';
export { render } from './render.ts';

export type {
    Props,
    Child
} from './types.ts';
