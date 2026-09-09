/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @internal The ONE place a negotiated response is told what it varies on.
 *
 * A body that depends on a request header is only safely shared if every cache in front of it is
 * told which header. The kit's own page cache keys on the resolved language directly; this is for
 * the caches it does not control. It lives in its own module because there are two families of
 * handler that need it - the per-request mounts and the ISR host - and a stamp that exists twice is
 * a stamp that gets corrected once.
 *
 * @param response - The answer to stamp.
 * @param vary - The field names the body depends on, or undefined when nothing varies.
 * @returns The same response, or a copy carrying the merged `Vary`.
 */
export function mergeVary(response: Response, vary: string | undefined): Response
{
    if (vary === undefined)
    {
        return response;
    }
    const existing = response.headers.get('vary');
    const merged = existing === null || existing.trim() === '' ? vary : `${ existing }, ${ vary }`;
    // Headers are immutable on some responses (a streamed one built with a literal init is not),
    // so the header is set on a clone-safe copy only when it must be.
    const headers = new Headers(response.headers);
    headers.set('vary', merged);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
