/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The denial sentinels: what a guard returns (or throws) to separate "not signed in" from
 * "signed in, and still not allowed".
 *
 * `return false` has always vetoed, and the server answered 403 for it. That is right for
 * exactly one of the two cases: a signed-out visitor needs 401, so a client, a crawler or an
 * edge cache can tell "authenticate and retry" from "never, for you". Two names rather than a
 * status argument, because these are the only two states the route lifecycle renders - and a
 * name reads at the call site without looking a number up.
 *
 * The third member of the family that starts at {@link redirect} and {@link notFound}, and it
 * travels the same path: the server surfaces it from `matchAndLoad` as the `blocked` outcome,
 * and the client settles the navigation into that same blocked state at the same URL, so a
 * deep link and an in-app click agree.
 */

/** @internal The brand distinguishing a denial from an ordinary verdict or error. */
const DENIED: unique symbol = Symbol('azerothjs.router.denied');

/** The sentinel {@link unauthorized} and {@link forbidden} build. */
export interface Denied
{
    readonly [DENIED]: 401 | 403;
}

/**
 * Denies with 401: no usable credentials. The visitor may retry after authenticating, and a
 * sign-in wall is the UI that belongs on it.
 *
 * @example
 * guard: () => session() !== null ? true : unauthorized()
 */
export function unauthorized(): Denied
{
    return { [DENIED]: 401 };
}

/**
 * Denies with 403: the credentials were understood and are still insufficient. Retrying will
 * not help, so the UI says so rather than offering a sign-in.
 *
 * @example
 * guard: () => session()?.role === 'admin' ? true : forbidden()
 */
export function forbidden(): Denied
{
    return { [DENIED]: 403 };
}

/** Whether a returned or thrown value is a denial sentinel. */
export function isDenied(value: unknown): value is Denied
{
    if (typeof value !== 'object' || value === null)
    {
        return false;
    }
    const status = (value as { [DENIED]?: unknown })[DENIED];
    return status === 401 || status === 403;
}

/** The status a denial carries - the one the server answers and the blocked state reports. */
export function deniedStatus(denied: Denied): 401 | 403
{
    return denied[DENIED];
}

/** @internal The denial pinned on the string render currently running, if any. */
let renderDenial: 401 | 403 | null = null;

/**
 * SERVER: pins one string render to the blocked state.
 *
 * The SSR render of a vetoed URL is the authorization bypass in miniature: guards do not run
 * in string mode (the server ran them once, in `matchAndLoad`), so a router left to its own
 * devices would serialize the very component the guard declined. Pinning it here closes that
 * by CONSTRUCTION - the app entry cannot forget to forward a prop, because it is never asked
 * to. Synchronous by contract: the blocked outcome is always rendered buffered, and a string
 * render never interleaves with another.
 *
 * @internal Used by the SSR host; applications reach this state through their guards.
 */
export function renderAsDenied<T>(status: 401 | 403, render: () => T): T
{
    const previous = renderDenial;
    renderDenial = status;
    try
    {
        return render();
    }
    finally
    {
        renderDenial = previous;
    }
}

/** @internal The pin {@link renderAsDenied} set, read by `createRouter`. */
export function currentRenderDenial(): 401 | 403 | null
{
    return renderDenial;
}

/**
 * @internal The denial a server handoff carries, for a hydrating client to agree with the
 * markup on its first pass - before any guard has had a chance to re-derive it.
 */
export function seededDenial(handoff: { denied?: number } | undefined): 401 | 403 | null
{
    const status = handoff?.denied;
    return status === 401 || status === 403 ? status : null;
}
