/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The ambient request: the one runtime-owned slot that lets a component, and a module-scope
 * client it calls, find the `Request` the server is answering.
 *
 * The request itself travels as a VALUE - the loader and guard arguments carry it - because a
 * value is the only thing that crosses an SSR bundle boundary reliably. A component takes no
 * arguments, so it needs a second channel, and this is it: one WeakMap keyed on the active
 * store scope, which is already the per-request identity on a host with an async-context
 * resolver and the per-render identity inside every string render.
 *
 * Keying on the scope rather than on a module variable is what makes it survive `await` without
 * bleeding: the resolver hands every concurrently interleaved request its own scope object, and
 * a render frame is a fresh object per render. The install REFUSES at the default scope, which
 * is process-lifetime and would hand one visitor's request to the next.
 *
 * Reading identity is also RECORDED here, on the request: a page whose render consulted the
 * visitor is a function of (URL, identity) and its host must answer it `private, no-store`
 * instead of caching or sharing it.
 */

import { getStoreScope, isDefaultScope } from '../reactivity/store-scope.ts';
import { isBuildContext } from '../reactivity/data-cache.ts';
import { DEV } from '../reactivity/dev.ts';

/** The active scope -> the request that scope is answering. Dies with the scope object. */
const scopedRequests = new WeakMap<object, Request>();

/** The default-scope refusal speaks once per process, like the data cache's own disable. */
let refusalWarned = false;

/**
 * @internal The slot marking a request whose identity was consulted. A REGISTRY symbol: the
 * writer and the reader can be different copies of this package (an SSR bundle and the host's
 * node_modules), and a unique symbol would not be the same key across them.
 */
export const REQUEST_READ: unique symbol = Symbol.for('azeroth.request.read');

/**
 * @internal Records that this request's identity was consulted. Non-enumerable, so no logger
 * or serializer that walks the request surfaces it. Idempotent.
 */
export function markRequestRead(request: Request): void
{
    Object.defineProperty(request, REQUEST_READ, { value: true, configurable: true });
}

/**
 * @internal Whether anything consulted this request's identity: an `args.request` read, a
 * non-null {@link useRequest}, or an in-process api dispatch made with the visitor's headers.
 * The host reads it after the loaders and the main pass to decide whether the page may be
 * cached or shared.
 *
 * @param request - The request the pass was given.
 * @returns True when identity was consulted.
 */
export function requestWasRead(request: Request): boolean
{
    return (request as { [REQUEST_READ]?: boolean })[REQUEST_READ] === true;
}

/**
 * @internal Makes `request` the ambient one for the scope active at THIS call, which is why
 * every entry point installs at its own entry rather than delegating: a guard walk installs
 * into the request root's scope and a render installs into the frame it just opened.
 *
 * Refuses at the default scope, where an entry would outlive its request and be read by the
 * next one. The refusal is the normal state in a browser and silent there; on a server it is a
 * misconfiguration with exactly two causes, and the DEV diagnostic names both, once per
 * process.
 *
 * @param request - The request this pass is answering.
 */
export function installRequestContext(request: Request): void
{
    const scope = getStoreScope();
    if (isDefaultScope(scope))
    {
        if (DEV && !isBuildContext() && !refusalWarned)
        {
            refusalWarned = true;
            console.warn('[azeroth] the request could not be made ambient at the default scope, so '
                + 'useRequest() reads null here. Either there is no @azerothjs/http request root around '
                + 'this call (wrap HTTP work in runInRequestRoot), or this bundle resolved a SECOND copy '
                + 'of azerothjs and the host installed the resolver on the other one - check ssr.external.');
        }
        return;
    }
    scopedRequests.set(scope, request);
}

/**
 * The live `Request` this server pass is answering, or null where there is none.
 *
 * HYDRATION HAZARD, stated first because it decides whether you may call this at all: this is
 * null in the browser, so markup rendered from it CANNOT hydrate - the client rebuilds the same
 * component with no request and produces different output. The supported way to SHOW identity
 * is to read it in the loader and let the value ride the handoff to the client; this read
 * exists for server-only decisions that hydrate to identical markup.
 *
 * Non-null inside a server guard walk, a loader, and a per-request render and its Suspense
 * continuations (a continuation re-enters its main pass's scope, so it reads the same request
 * as the shell), and inside a page action body, which its POST's authorizing walk installed the
 * request for. Null in the browser, in a shared render (ISR regeneration, a build-time
 * prerender), and in a background work unit.
 *
 * Reading it non-null marks the page a function of the visitor's identity: the host answers it
 * `private, no-store` and never caches or shares it.
 *
 * @returns The request, or null.
 * @example
 * // Server-only decision, identical markup either way.
 * const theme = useRequest()?.headers.get('sec-ch-prefers-color-scheme') === 'dark' ? 'dark' : 'light';
 *
 * @see The `request` member of the loader and guard arguments, the value channel this mirrors.
 */
export function useRequest(): Request | null
{
    const request = scopedRequests.get(getStoreScope());
    if (request === undefined)
    {
        return null;
    }
    markRequestRead(request);
    return request;
}
