/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Registers teardown work with whatever reactive scope is running. An effect body can
 * return only one cleanup function; onCleanup lets a single run register any number of
 * them, including conditionally, so each teardown sits next to the setup it undoes.
 */

import type { CleanupFn } from './types.ts';
import { currentCleanups } from './graph.ts';
import { registerDisposer } from './create-root.ts';

/**
 * Registers a cleanup function with the enclosing reactive scope. Where it attaches, and
 * therefore when it runs, depends on where it is called:
 *
 * - Inside an effect run, it joins that run's cleanups and fires before the effect's NEXT
 *   run as well as on disposal. Each run starts from a clean slate, so a cleanup must undo
 *   exactly what its own run set up.
 * - Inside a createRoot body or a component body, with no effect running, it attaches to
 *   that scope and fires when the scope is disposed.
 * - Outside every scope it is a no-op rather than a throw, so a component that calls it
 *   does not explode when rendered in a bare unit test.
 *
 * Must be called synchronously. A call made after an `await` has lost the scope it meant
 * to register with.
 *
 * @param fn - The teardown callback.
 * @example
 * createEffect(() =>
 * {
 *     const id = setInterval(tick, 1000);
 *     onCleanup(() => clearInterval(id));
 *
 *     if (isPolling())
 *     {
 *         const poller = setInterval(poll, 3000);
 *         onCleanup(() => clearInterval(poller)); // registered only on this branch
 *     }
 * });
 *
 * @see {@link createEffect}
 * @see {@link createRoot}
 */
export function onCleanup(fn: CleanupFn): void
{
    if (currentCleanups !== null)
    {
        currentCleanups.push(fn);
        return;
    }
    // No run in progress, but there may still be a scope: a createRoot body, or a component body
    // executing inside one. Registering with the owner makes the callback fire when that scope
    // is disposed. Falling through instead left the documented pattern silently doing nothing.
    registerDisposer(fn);
}
