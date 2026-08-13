/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The dispose function for each container's mounted tree, so a later render or hydrate on the
 * same container tears the previous mount down first.
 *
 * Shared between the two: either can dispose the other's mount, which is what a
 * hydration-mismatch fallback does when it re-renders. Keyed weakly, so a discarded container
 * does not retain its disposer.
 */

import type { DisposeFn } from '../reactivity/index.ts';

/**
 * Maps each container element to the dispose function for its current mount.
 *
 * @internal
 */
export const containerDisposers: WeakMap<HTMLElement, DisposeFn> = new WeakMap();
