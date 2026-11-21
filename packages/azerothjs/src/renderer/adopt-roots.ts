/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createRoot } from '../reactivity/create-root.ts';
import { currentErrorHandler } from '../reactivity/catch-error.ts';
import { routeAsyncError } from '../reactivity/create-effect.ts';
import type { DisposeFn } from '../reactivity/types.ts';

/**
 * A hydrated branch or row eventually owns its detached root. Until the entire range
 * matches, retain every disposer, including that of the row currently being built.
 * On success the caller's normal teardown takes ownership.
 */
export function withHydrationRoots<T>(adopt: (openRoot: typeof createRoot) => T): T
{
    const pending: DisposeFn[] = [];
    const openRoot: typeof createRoot = build => createRoot(dispose =>
    {
        pending.push(dispose);
        return build(dispose);
    });
    try
    {
        return adopt(openRoot);
    }
    catch (error)
    {
        for (const dispose of pending.reverse())
        {
            try
            {
                dispose();
            }
            catch (cleanupError)
            {
                // Finish every rollback and preserve the original mismatch or application
                // error. Report a separate cleanup failure to the scope that owned the walk.
                const handler = currentErrorHandler;
                queueMicrotask(() => routeAsyncError(cleanupError, handler, undefined));
            }
        }
        throw error;
    }
}
