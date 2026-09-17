/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Stamping the in-process api onto the request a host is about to render.
 *
 * The writer half of the bridge, which needs the request root and the App and therefore lives
 * apart from `bridge.ts` - that file is the shape and the reader, and both a browser bundle and
 * an SSR bundle reach it through `./api/shared`, so it must stay free of server code.
 */

import { REQUEST_READ } from 'azerothjs/internal';
import { API_BRIDGE, apiBridgeOf, bridgeMethodRefusal, bridgeOriginRefusal, type ApiBridge } from './bridge.ts';
import { currentApiRegistration } from '../request-root.ts';
import { forwardIdentity } from '../forward-identity.ts';

/**
 * Gives this request the api registered on the App answering it - or on an App enclosing that
 * one - so a guard, a loader and a component all reach the same in-process transport. A no-op
 * when the request already carries a bridge, and when no api is registered anywhere in the root
 * chain: whether a bridge exists is decided by registration, never by a mount option.
 *
 * The property is non-enumerable, so nothing that walks or serializes the request surfaces it,
 * and it dies with the request object.
 *
 * @internal
 * @param request - The request about to be walked, loaded or rendered.
 */
export function attachApiBridge(request: Request): void
{
    if (apiBridgeOf(request) !== undefined)
    {
        return;
    }
    const registration = currentApiRegistration();
    if (registration === undefined)
    {
        return;
    }
    const bridge: ApiBridge = {
        manifest: registration.manifest,
        prefix: registration.prefix,
        dispatch: async (inner: Request): Promise<Response> =>
        {
            const target = new URL(inner.url);
            if (inner.method !== 'GET' && inner.method !== 'HEAD')
            {
                // Refused HERE as well as at the client's call site: the bridge is a property of
                // an object anyone holding the request can read, so the rule has to hold for
                // every holder, not only for the typed client.
                throw new Error(bridgeMethodRefusal(inner.method, target.pathname));
            }
            const pageOrigin = new URL(request.url).origin;
            if (target.origin !== pageOrigin)
            {
                // The same pairing as the method rule: the client never builds an off-origin url
                // for the bridge, and this is what holds when something else does.
                throw new Error(bridgeOriginRefusal(target.href, pageOrigin));
            }
            // A forwarded cookie makes the answer a function of the visitor, so the page that
            // dispatched is private from here on.
            Object.defineProperty(request, REQUEST_READ, { value: true, configurable: true });
            // The page's signal rides along, so a disconnect reaches the handler and the nested
            // root's abort-as-settle fires instead of leaving an orphan running.
            const dispatched = forwardIdentity(request, new Request(inner, { signal: request.signal }));
            return await registration.app.handle(dispatched);
        }
    };
    Object.defineProperty(request, API_BRIDGE, { value: bridge, configurable: true });
}
