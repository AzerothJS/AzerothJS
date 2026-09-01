/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Reads what this page's ACTION returned when it refused a form submit.
 *
 * A returned value is the classic validation re-render: the write did not happen, the page
 * rendered again at 422, and this is where its field errors arrive. It is undefined on every
 * ordinary render, because a successful action redirects instead (POST/Redirect/GET) and there
 * is nothing to carry.
 */

import type { Getter } from '../reactivity/index.ts';
import type { Router } from './router.ts';
import { resolveRouter } from './provider.ts';

/**
 * The current page's action refusal, or undefined.
 *
 * @typeParam T - What the action returns when it refuses; the caller names it, since only the
 *                application knows the shape it chose.
 * @param router - Omit inside a `<RouterProvider>`.
 * @returns A getter for the refusal.
 * @example
 * const refusal = useActionResult<{ fields: Record<string, string> }>();
 *
 * <p class="error">{ () => refusal()?.fields.title ?? '' }</p>
 */
export function useActionResult<T = unknown>(router?: Router): Getter<T | undefined>
{
    const resolved = resolveRouter(router, 'useActionResult');
    return () => resolved.actionResult() as T | undefined;
}
