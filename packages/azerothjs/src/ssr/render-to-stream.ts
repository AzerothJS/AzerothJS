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
import { discardStyleFrame } from '../renderer/css.ts';
import { discardHeadFrame } from '../renderer/head.ts';
import { escapeAttr, inertJson } from '../reactivity/ssr.ts';
import { latchServerData } from '../reactivity/data-cache.ts';

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
 * THE CALLER OWNS THE MAIN PASS'S FRAMES. `css()` and `useHead()` have no document to write
 * into here, so the main pass records them and this call returns with them still pending: the
 * caller drains them with {@link collectStyleSheet} and `collectHead` (azerothjs/internal) into
 * the head it builds around the stream, and must reach that drain on EVERY path out of the
 * call - a `finally`, not a straight line - because a frame left pending is published by
 * whichever render collects next, in an unrelated request's document. Only two frames are
 * self-handled: a main pass that THROWS discards its own (no document will be built), and a
 * Suspense continuation's frame is dropped where it is written, since the head has already
 * flushed by then.
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
 * @see {@link collectStyleSheet} for the style drain the caller owes this render.
 */
export function renderToStream(
    component: () => HTMLElement | DocumentFragment,
    options: RenderToStreamOptions = {}
): ReadableStream<Uint8Array>
{
    // A server entry point: from here on, default-scope reads bypass the data cache (see
    // data-cache).
    latchServerData();
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
        // The response's collect will never run (the caller got a throw, not a stream), so
        // the main pass's style/head frames are discarded here or a LATER render's collect
        // would serve them. This is the ONLY finalize-adjacent discard of the MAIN frame:
        // a page with no pending boundary finalizes synchronously inside the stream
        // constructor, BEFORE the host drains the frames, and discarding there threw away
        // every per-render css``/useHead of a settled streamed page. Continuation frames
        // are discarded in the continuation drive itself.
        const scope = session.storeScope;
        if (scope !== null)
        {
            discardStyleFrame(scope);
            discardHeadFrame(scope);
        }
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
                    finally
                    {
                        // SYNCHRONOUS with the continuation's render: a css`` or useHead
                        // evaluated in it registered into a frame nothing will drain (this
                        // response's collect already ran), and any interleaved request's
                        // collect would otherwise serve those values in ITS document.
                        // Discarding here, in the same task as the write, leaves no window.
                        discardStyleFrame(session.storeScope as object);
                        discardHeadFrame(session.storeScope as object);
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
        json = inertJson(seeds);
    }
    catch
    {
        // Non-JSON-serializable data: omit the seeds; the client refetches after hydration.
        json = '{}';
    }
    const attribute = nonce === undefined ? '' : ` nonce="${ escapeAttr(nonce) }"`;
    return `<template data-azs="${ boundary.id }">${ children }</template>`
        + `<script type="application/json" data-azs-seed="${ boundary.id }">${ json }</script>`
        + `<script${ attribute }>__AZS(${ boundary.id });document.currentScript.remove()</script>`;
}
