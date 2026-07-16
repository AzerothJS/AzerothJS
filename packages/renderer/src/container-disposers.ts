/**
 * MODULE: renderer/container-disposers (internal)
 *
 * Tracks the dispose function for each container's mounted tree, so a later render()/hydrate()
 * on the same container tears down the previous mount first. Shared between render and hydrate -
 * either can dispose the other's mount (e.g. a hydration-mismatch fallback that re-renders).
 * Keyed weakly so a discarded container does not retain its disposer.
 */

import type { DisposeFn } from '@azerothjs/reactivity';

/**
 * Maps each container element to the dispose function for its current mount.
 *
 * @internal
 */
export const containerDisposers: WeakMap<HTMLElement, DisposeFn> = new WeakMap();
