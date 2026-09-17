/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * What an in-process sub-call inherits from the request that started it.
 *
 * One ALLOWLIST, and everything outside it is refused by construction - a denylist admits every
 * header nobody thought about, which is the whole failure mode this function exists to prevent.
 */

import { requestIdOf, stampRequestId } from './edge.ts';

/**
 * The identity headers a sub-call inherits. `host` is not here on purpose: the dispatched url
 * already carries the page's authority, and copying the header on top would let a forged Host
 * reach the handler twice over.
 */
const FORWARDED = ['cookie', 'authorization', 'accept-language'] as const;

/**
 * Copies the visitor's identity from a page request onto a request about to be dispatched in
 * process, and returns the request to dispatch. `cookie`, `authorization` and `accept-language`
 * are carried, and only where the call has not set them itself - a header the caller supplied
 * wins, so `ClientOptions.headers: { authorization }` is never overwritten by the visitor's.
 * The correlation id is stamped from {@link requestIdOf}, not from the inbound header, so a
 * sub-call's log lines correlate with the page's without trusting a client-forged value.
 * Everything else is refused: `host`, `content-length`, the hop-by-hop set, `origin`,
 * `referer`, `sec-fetch-*`, `x-forwarded-*`, conditional and range headers, `accept-encoding`
 * and the csrf header.
 *
 * TWO FACTS THIS DOES NOT CHANGE, both of which decide whether an in-process call is safe in a
 * given app. An in-process call enters at `app.handle`, so it runs the App's own middleware,
 * guards and validation but NOT an outer `pipeline(app, requestId(), securityHeaders(),
 * csrfCookie(), rateLimit())` - authorization that lives in a pipeline layer rather than in a
 * guard is not applied to it. (`csrfProtect` cannot be one of those layers: it is a guard by
 * type, so every csrf spelling the kernel offers runs inside `app.handle` and therefore on the
 * in-process leg too.) And `clientIp` is not carried: an in-process request has no peer, and
 * copying one would double-count a single visitor against an ip-keyed limit - a rate limiter
 * installed with `app.use` rather than in the pipeline DOES run here, and its default key
 * throws 500 `rate-limit-key-unavailable`, so keep it in the pipeline.
 *
 * No `accept-encoding` is forwarded, which matters for one composition: the typed client's
 * response reader does not decode a content-encoding, so a host that composes
 * `compressResponse` INSIDE its App rather than on the way out would break the in-process leg.
 *
 * @param from - The page request whose identity is being forwarded.
 * @param to - The request about to be dispatched; its own headers win, and its body moves to
 *   the returned request, so the value passed in is consumed.
 * @returns The request to dispatch.
 * @example
 * const answer = await app.handle(forwardIdentity(pageRequest, new Request('/api/me')));
 */
export function forwardIdentity(from: Request, to: Request): Request
{
    const headers = new Headers(to.headers);
    for (const name of FORWARDED)
    {
        const value = from.headers.get(name);
        if (value !== null && !headers.has(name))
        {
            headers.set(name, value);
        }
    }
    const forwarded = new Request(to, { headers });
    const id = requestIdOf(from);
    if (id !== undefined)
    {
        stampRequestId(forwarded, id);
    }
    return forwarded;
}
