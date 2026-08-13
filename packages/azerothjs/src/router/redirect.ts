/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The navigation-control sentinel: the value a loader THROWS, or a guard returns, to turn
 * the in-flight navigation into a different one.
 *
 * The router recognizes it wherever it surfaces - a guard verdict, a loader rejection, even a
 * loader rejection observed server-side by matchAndLoad, which surfaces it so the SSR layer
 * can answer with a real 302.
 *
 * It REPLACES by default. Under the immediate-URL model the interrupted navigation has
 * already written its entry, and a redirect should not leave that dead URL on the back stack.
 * Pass `{ replace: false }` to push instead.
 */

import type { NavigateTarget } from './types.ts';

/** @internal The brand distinguishing a redirect sentinel from an ordinary error/value. */
const REDIRECT: unique symbol = Symbol('azerothjs.router.redirect');

/** The sentinel {@link redirect} builds; recognized by the router wherever it surfaces. */
export interface Redirect
{
    readonly [REDIRECT]: true;

    /** Where to go instead. */
    to: NavigateTarget;

    /** Whether the redirect replaces the interrupted entry (default) or pushes. */
    replace: boolean;
}

/**
 * Builds a redirect sentinel. THROW it from a loader (`throw redirect('/login')`) or
 * return it from a guard; the router cancels the in-flight navigation and goes there.
 *
 * @example
 * loader: async ({ params, signal }) =>
 * {
 *     const user = await fetchUser(params.id, signal);
 *     if (user === null) { throw redirect('/users'); }
 *     return user;
 * }
 */
export function redirect(to: NavigateTarget, options: { replace?: boolean } = {}): Redirect
{
    return { [REDIRECT]: true, to, replace: options.replace ?? true };
}

/** @internal Whether a thrown/returned value is a redirect sentinel. */
export function isRedirect(value: unknown): value is Redirect
{
    return typeof value === 'object' && value !== null && (value as { [REDIRECT]?: unknown })[REDIRECT] === true;
}
