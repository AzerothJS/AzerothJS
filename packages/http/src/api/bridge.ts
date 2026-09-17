/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The in-process api capability, as a property of one request.
 *
 * A page rendered on the server may call the app's OWN api without a socket: the host stamps
 * the bridge on the request it is about to render, and the typed client finds it there. This
 * module is the half BOTH sides import - the shape, the reader and the one refusal text - and
 * it speaks no server code, so an SSR bundle or a browser bundle that reaches the client can
 * read a bridge without dragging the kernel along.
 *
 * The key is a REGISTRY symbol deliberately: the writer (the host's node_modules copy) and the
 * reader (the copy inside an SSR bundle) are different artifacts, and a unique symbol would not
 * be the same key across them.
 */

import type { Manifest } from './declare.ts';

/** @internal The slot the bridge is stamped on; a registry symbol so two copies agree. */
export const API_BRIDGE: unique symbol = Symbol.for('azeroth.api.bridge');

/** The in-process api a request carries: what is registered, and how to call it. */
export interface ApiBridge
{
    /** The registered manifest, so a client built with an empty one can still resolve a group. */
    manifest: Manifest;

    /**
     * The prefix the api is served under. Nothing here routes on it - a call's path comes from
     * the client's own baseUrl - so it is for a host building its own client, or a diagnostic
     * that needs to say where the api this request can reach is mounted.
     */
    prefix: string;

    /**
     * Runs one request through the registered App in process, with the page request's identity
     * forwarded and its signal attached. GET and HEAD only, and at the page's own origin only: a
     * write is never dispatched with a forwarded cookie behind an edge pipeline that did not run,
     * and another authority's url is not this App's to answer.
     */
    dispatch(request: Request): Promise<Response>;
}

/**
 * @internal The bridge stamped on this request, or undefined when it carries none (no api
 * registered anywhere in the root chain, or a request the host never handed to a render).
 */
export function apiBridgeOf(request: Request): ApiBridge | undefined
{
    return (request as { [API_BRIDGE]?: ApiBridge })[API_BRIDGE];
}

/**
 * @internal The ONE refusal text for a non-safe method over the bridge. The client raises it at
 * the call site and the dispatcher raises it again, so either check alone still refuses; one
 * function so the two cannot drift into two different explanations.
 */
export function bridgeMethodRefusal(method: string, path: string): string
{
    return `${ method } ${ path } cannot be served in process: the api bridge serves GET and HEAD only. `
        + 'A write dispatched in process would carry the visitor\'s forwarded cookie through the App\'s own '
        + 'guards while the edge pipeline around it never ran. Call it from the browser, or over the wire '
        + 'with an absolute baseUrl.';
}

/**
 * @internal The ONE refusal text for a dispatch addressed off the page's origin, paired with the
 * method refusal for the same reason: the bridge is a property anyone holding the request can
 * read, so the target rule has to hold for every holder.
 */
export function bridgeOriginRefusal(target: string, pageOrigin: string): string
{
    return `${ target } cannot be served in process: the api bridge dispatches at the page's own origin `
        + `(${ pageOrigin }) only. Another authority is somebody else's service, and answering it here would `
        + 'hand the local App a foreign address with the visitor\'s forwarded cookie on it. Call it over the '
        + 'wire with an absolute baseUrl.';
}
