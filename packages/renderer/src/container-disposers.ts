// ============================================================================
// AZEROTHJS — Container Disposers (shared by render & hydrate)
// ============================================================================
//
// Tracks the dispose function for each container's mounted tree, so a later
// render()/hydrate() on the same container tears down the previous mount
// first. Shared between render() and hydrate() (each can dispose the other's
// mount — e.g. a hydration-mismatch fallback that re-renders).
//
// ============================================================================

import type { DisposeFn } from '@azerothjs/reactivity';

/**
 * Maps each container element to the dispose function for its current mount.
 */
export const containerDisposers = new WeakMap<HTMLElement, DisposeFn>();
