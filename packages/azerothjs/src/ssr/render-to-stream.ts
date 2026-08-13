/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Streaming SSR over the SAME serializer renderToString runs. The main pass executes
 * synchronously inside the call - a top-level throw propagates to the caller before any
 * byte exists, so error pages stay ordinary buffered responses - and emits the shell with
 * every pending Suspense boundary's fallback in place under an id-suffixed marker. Each
 * boundary's resources were started eagerly at creation (fetch time overlaps
 * serialization); as they settle, the boundary's children serialize in a continuation
 * window (same owner, same store scope, same session) and stream as an out-of-order
 * chunk: a template, a seed script, and one `__AZS(id)` swap call. The reactive root
 * stays alive until the stream finishes - finalize (idempotent) disposes it, aborts
 * unconsumed fetches, and clears the settle timer, whether reached by completion,
 * timeout, caller abort, or transport cancel.
 */

import { createRoot, isSSRNode, runInMode, runInStoreScope } from '../reactivity/index.ts';
import { markSelectedOption, markSelectedOptions } from '../renderer/ssr.ts';
import { StreamSession, getStoreScope, runInExistingStoreScope } from '../reactivity/internal.ts';
import type { PendingBoundary } from '../reactivity/internal.ts';
import { streamRuntimeScript } from '../renderer/stream-swap.ts';

/** How {@link renderToStream} behaves; every field optional. */
export interface RenderToStreamOptions
{
    /** Aborts the render (client disconnect): fetches abort, the stream ends, the root disposes. */
    signal?: AbortSignal;

    /**
     * Milliseconds a pending boundary may stay unsettled before the stream gives up on it
     * (default 10000). On fire the remaining fetches abort and the stream closes with those
     * boundaries still showing their fallbacks - exactly the buffered-render degradation:
     * the client fetches after hydration.
     */
    settleTimeoutMs?: number;

    /** CSP nonce stamped onto every inline script the stream emits. */
    scriptNonce?: string;

    /** Hears a continuation failure (a boundary whose children threw while streaming). */
    onError?: (error: unknown) => void;
}

/** @internal The default settle ceiling: far past any sane data fetch, far short of forever. */
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Renders a component as a streaming HTML response: the shell flushes immediately with
 * Suspense fallbacks in place, and each pending boundary's settled children follow as an
 * out-of-order swap chunk.
 *
 * A buffered render's first byte waits for the SLOWEST piece of data. Streaming sends
 * everything that needs no waiting now and the rest the moment it exists, which makes
 * time-to-first-byte a serialization cost rather than a data cost.
 *
 * A top-level throw propagates from THIS call, before a single byte has flushed, so an error
 * page stays an ordinary buffered response. A throw in a continuation instead drops that one
 * boundary's chunk - its fallback stays and the client refetches after hydration - reports
 * through `onError`, and lets the stream continue.
 *
 * The stream always terminates validly: settling, timing out, an abort and a transport
 * cancel all funnel into one idempotent finalize.
 *
 * Markers are always on, since a streamed page exists in order to hydrate.
 *
 * @param component - A thunk building the root element, as renderToString takes. Suspense
 *                    boundaries with pending resources become streamed chunks; everything
 *                    else serializes exactly as a buffered render would.
 * @param options - Streaming behaviour, including `signal` and `onError`.
 * @returns A stream of UTF-8 HTML: the shell first, then template, seed and swap triplets.
 * @example
 * const stream = renderToStream(() => App({ url }), { signal: request.signal });
 * return new Response(stream, { headers: { 'content-type': 'text/html; charset=utf-8' } });
 *
 * @see {@link renderToString} for the buffered form.
 */
export function renderToStream(
    component: () => HTMLElement | DocumentFragment,
    options: RenderToStreamOptions = {}
): ReadableStream<Uint8Array>
{
    if (typeof component !== 'function')
    {
        throw new TypeError('renderToStream expects a THUNK that builds the tree, e.g. '
            + 'renderToStream(() => App(props)) - the tree must build INSIDE the streaming render.');
    }

    const session = new StreamSession(options.signal);
    const encoder = new TextEncoder();

    // MAIN PASS: synchronous, root disposal DEFERRED to finalize. A throw finalizes (the
    // root is already registered) and propagates - the caller answers with a buffered 500.
    let mainHtml = '';
    try
    {
        runInMode('string', () => runInStoreScope(() => createRoot((dispose): void =>
        {
            session.onFinalize(dispose);
            session.storeScope = getStoreScope();
            const node = component() as unknown;
            mainHtml = Array.isArray(node)
                ? (node as unknown[]).map(n => (isSSRNode(n) ? n.html : String(n))).join('')
                : (isSSRNode(node) ? node.html : String(node));
        })), { markers: true, session });
    }
    catch (error)
    {
        session.finalize();
        throw error;
    }

    const initial = session.takeBoundaries();
    const nonce = options.scriptNonce;

    return new ReadableStream<Uint8Array>({
        start(controller): void
        {
            let closed = false;
            let runtimeSent = false;
            let pending = initial.length;

            const enqueue = (text: string): void =>
            {
                if (!closed)
                {
                    controller.enqueue(encoder.encode(text));
                }
            };
            const finish = (): void =>
            {
                if (closed)
                {
                    return;
                }
                closed = true;
                session.finalize();
                controller.close();
            };

            enqueue(mainHtml);
            if (pending === 0)
            {
                finish();
                return;
            }

            const timer = setTimeout(finish, options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
            session.onFinalize(() => clearTimeout(timer));
            if (options.signal !== undefined)
            {
                if (options.signal.aborted)
                {
                    finish();
                    return;
                }
                options.signal.addEventListener('abort', finish, { once: true });
            }

            const settleOne = (): void =>
            {
                pending--;
                if (pending === 0)
                {
                    finish();
                }
            };

            const drive = (boundary: PendingBoundary): void =>
            {
                void Promise.allSettled(boundary.entries.map((entry) => entry.promise)).then(() =>
                {
                    if (closed)
                    {
                        return;
                    }
                    let childrenHtml: string | null = null;
                    try
                    {
                        childrenHtml = runInMode('string',
                            () => runInExistingStoreScope(session.storeScope as object, () => boundary.render()),
                            { markers: true, session });
                    }
                    catch (error)
                    {
                        // The fallback DOM stays; the client's unseeded resources refetch
                        // after hydration and the error re-surfaces through client Suspense.
                        options.onError?.(error);
                    }
                    if (childrenHtml !== null)
                    {
                        // Boundaries the continuation itself registered (nested Suspense)
                        // join the pending set BEFORE this one settles the counter.
                        for (const nested of session.takeBoundaries())
                        {
                            pending++;
                            drive(nested);
                        }
                        // One enqueue per settled boundary: the runtime (first time) and the
                        // chunk travel together, so a reader never sees a half-delivered swap.
                        const prefix = runtimeSent ? '' : streamRuntimeScript(nonce);
                        runtimeSent = true;
                        enqueue(prefix + chunkFor(boundary, childrenHtml, nonce));
                    }
                    settleOne();
                });
            };

            for (const boundary of initial)
            {
                drive(boundary);
            }
        },
        cancel(): void
        {
            session.finalize();
        }
    });
}

/** @internal One settled boundary as its wire chunk: template + seed script + swap call. */
function chunkFor(boundary: PendingBoundary, childrenHtml: string, nonce: string | undefined): string
{
    // The enclosing <select>'s value, recorded when it serialized (see ssr.ts). Marking here is
    // what keeps a streamed page's first paint correct: the swap inserts these options directly,
    // and until hydration runs nothing else can express the selection.
    let children = childrenHtml;
    const select = boundary.select;
    if (select !== undefined)
    {
        children = Array.isArray(select.desired) && select.multiple
            ? markSelectedOptions(children, select.desired as readonly string[])
            : markSelectedOption(children, select.desired as string);
    }

    const seeds: Record<string, { d?: unknown; e?: string }> = {};
    for (const entry of boundary.entries)
    {
        seeds[entry.id] = entry.read();
    }
    let json: string;
    try
    {
        json = JSON.stringify(seeds);
    }
    catch
    {
        // Non-JSON-serializable data: omit the seeds; the client refetches after hydration.
        json = '{}';
    }
    // The one escape that matters inside an inert script: '<' cannot open '</script>'.
    json = json.replace(/</g, '\\u003c');
    const attribute = nonce === undefined ? '' : ` nonce="${ nonce }"`;
    return `<template data-azs="${ boundary.id }">${ children }</template>`
        + `<script type="application/json" data-azs-seed="${ boundary.id }">${ json }</script>`
        + `<script${ attribute }>__AZS(${ boundary.id });document.currentScript.remove()</script>`;
}
