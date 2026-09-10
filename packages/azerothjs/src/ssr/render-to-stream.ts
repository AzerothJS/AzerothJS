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
import { escapeAttr, inertJson } from '../reactivity/ssr.ts';
import { latchServerData, releaseDataCache } from '../reactivity/data-cache.ts';
import { closeContinuationWindow, closeRenderWindow, openContinuationWindow, openRenderWindow } from '../renderer/frame.ts';
import { renderWithLocale } from '../i18n/current-locale.ts';
import { renderWithBase } from '../i18n/current-base.ts';
import type { RenderFrame, RenderWindow } from '../renderer/frame.ts';
import type { MountNode } from '../component/index.ts';

/** How {@link renderToStream} behaves; every field optional. */
export interface RenderToStreamOptions
{
    /**
     * The render frame the MAIN PASS writes into; continuations get internal frames that
     * are always discarded (the head has flushed by then). Construct with
     * `createRenderFrame()` and drain with it after this call returns - a host that
     * yields between the call and its drain is exactly who needs one.
     */
    frame?: RenderFrame;

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

    /**
     * The reader's language for this whole response, pinned for the main pass AND every
     * continuation.
     *
     * A boundary settles long after the call that started the render returned, so a pin scoped
     * to that call would have unwound by then and the deferred half of the page would render in
     * a different language from the half above it. The language belongs to the RESPONSE, so it
     * is held here rather than by whoever happens to be on the stack.
     */
    locale?: string;

    /**
     * The url prefix the document lives under (`/fa`), pinned like the locale for the main
     * pass and every continuation, so a router built anywhere in this response adopts it.
     * Checked where it is pinned: `/` and one language tag, nothing else.
     */
    base?: string;

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
 * THE CALLER OWNS THE MAIN PASS'S FRAME. `css()` and `useHead()` have no document to write
 * into here, so the main pass records them into a frame the caller should CONSTRUCT
 * (`createRenderFrame()`) and pass via `options.frame` - then drain with
 * {@link collectStyleSheet} and `collectHead` (azerothjs/internal) into the head it builds
 * around the stream, on any path and at any time: the frame is the caller's value, held
 * before the render runs and still in hand when it throws, and no other render can reach
 * it. A caller that passes no frame gets the legacy zero-argument drains, which serve one
 * synchronous render at a time and fail CLOSED (dropped with a dev diagnostic, never
 * served into another request's document) when a second render seals first. Two frames
 * are self-handled either way: a frameless main pass that THROWS discards its own, and a
 * Suspense continuation's frame is dropped where it is written, since the head has
 * already flushed by then.
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
    component: () => MountNode,
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
    // Applied to the main pass and to every continuation, since both render parts of ONE
    // response. An absent locale or base means the host has none, and nothing is pinned.
    const withLocale = <T>(render: () => T): T =>
        (options.locale === undefined ? render() : renderWithLocale(options.locale, render));
    const withDocument = <T>(render: () => T): T =>
        withLocale(() => (options.base === undefined ? render() : renderWithBase(options.base, render)));

    // MAIN PASS: synchronous, root disposal DEFERRED to finalize. A throw finalizes (the
    // root is already registered) and propagates - the caller answers with a buffered 500.
    let mainHtml = '';
    // A holder, not a plain let: the window is assigned inside the runInMode callback,
    // which control-flow analysis cannot see through - a property read is re-checked
    // after the call, a let is not.
    const mainWindow: { current: RenderWindow | null } = { current: null };
    try
    {
        runInMode('string', () => runInStoreScope(() => withDocument(() =>
        {
            // The main-pass render window, opened inside the store scope (see
            // renderer/frame.ts). The host that passed a frame owns it; kit's drain
            // rides a finally on this call and holds it on the throw path too.
            mainWindow.current = openRenderWindow(options.frame);
            createRoot((dispose): void =>
            {
                session.onFinalize(dispose);
                session.storeScope = getStoreScope();
                // The render scope is a scope-creating host, and finalize is the ONE funnel
                // every end path reaches - settle-all, timeout, signal abort, transport
                // cancel, AND the main-pass throw, which builds no stream at all (a release
                // wired into the stream's callbacks would miss it and pin this cache for the
                // retain window on every SSR error page). Late continuations find the cache
                // released and are gated in drive besides.
                session.onFinalize(() => releaseDataCache(session.storeScope as object));
                const node = component() as unknown;
                mainHtml = Array.isArray(node)
                    ? (node as unknown[]).map(n => (isSSRNode(n) ? n.html : String(n))).join('')
                    : (isSSRNode(node) ? node.html : String(node));
            });
            closeRenderWindow(mainWindow.current, 'success');
            mainWindow.current = null;
        })), { markers: true, session });
    }
    catch (error)
    {
        if (mainWindow.current !== null)
        {
            // The throw path's window exit: an owned frame clears, an unowned one
            // discards - replacing the old scope-keyed frame discards.
            closeRenderWindow(mainWindow.current, 'throw');
            mainWindow.current = null;
        }
        session.finalize();
        // The response's collect will never run (the caller got a throw, not a stream), so
        // the main pass's style/head frames are discarded here or a LATER render's collect
        // would serve them. This is the ONLY finalize-adjacent discard of the MAIN frame:
        // a page with no pending boundary finalizes synchronously inside the stream
        // constructor, BEFORE the host drains the frames, and discarding there threw away
        // every per-render css``/useHead of a settled streamed page. Continuation frames
        // are discarded in the continuation drive itself.
        throw error;
    }

    const initial = session.takeBoundaries();
    const nonce = options.scriptNonce;

    // The latch is shared by `start` and `cancel`: a transport cancel closes the controller
    // too, and every path that could touch it afterwards - the settle timer, a boundary
    // settling, the caller's abort signal - must find the latch set. Held outside `start`
    // because `cancel` is a sibling algorithm, not a closure inside it.
    let closed = false;
    let detachAbort: (() => void) | null = null;
    return new ReadableStream<Uint8Array>({
        start(controller): void
        {
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
                detachAbort?.();
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
                const signal = options.signal;
                signal.addEventListener('abort', finish, { once: true });
                // Detached at settle, not merely gated: a listener that outlives the stream
                // fires on a signal that outlives it, into a controller a cancel already closed.
                detachAbort = (): void => signal.removeEventListener('abort', finish);
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
                    // finalized covers what closed does not: cancel() finalizes without
                    // setting closed, and a continuation rendering after finalize would
                    // find its cache released - every cached read becoming a fresh
                    // UN-ABORTABLE direct fetch for a client that is already gone.
                    if (closed || session.finalized)
                    {
                        return;
                    }
                    let childrenHtml: string | null = null;
                    // The continuation's OWN window: created behind the drive gate, handed
                    // to no host, and discarded on every exit - the head has already
                    // flushed, so nothing declared here can reach this response's
                    // document, and it must never reach anyone else's.
                    let continuation: RenderWindow | null = null;
                    try
                    {
                        continuation = openContinuationWindow();
                        childrenHtml = runInMode('string',
                            () => runInExistingStoreScope(session.storeScope as object,
                                () => withDocument(() => boundary.render())),
                            { markers: true, session });
                    }
                    catch (error)
                    {
                        // The fallback DOM stays; the client's unseeded resources refetch
                        // after hydration and the error re-surfaces through client Suspense.
                        //
                        // ISOLATED: onError is USER code, and an observer is the last stop. Bare,
                        // its throw escaped this catch, skipped the settleOne() below, and left
                        // `pending` above zero - so the client waited out the whole settle timeout
                        // (measured: 1515ms against a 1500ms timeout, versus 3ms for an observer
                        // that returns) and the throw surfaced as an unhandled rejection out of
                        // the floating promise that drives this boundary.
                        try
                        {
                            options.onError?.(error);
                        }
                        catch
                        {
                            // Nowhere left to report it: reporting is what just failed.
                        }
                    }
                    finally
                    {
                        // SYNCHRONOUS with the continuation's render, in the same task as
                        // the write - no window in which an interleaved request could see
                        // anything, and the main frame (a different object entirely) is
                        // untouchable from here.
                        if (continuation !== null)
                        {
                            closeContinuationWindow(continuation);
                        }
                    }
                    // The boundary's accounting runs whatever happens above it: anything that
                    // throws before it strands the pending counter and hangs the stream to its
                    // settle timeout. Defence in depth rather than a live fix - with the observer
                    // isolated there is no reachable throw here - but it makes the invariant
                    // structural, so a statement added above cannot reintroduce the hang.
                    try
                    {
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
                    }
                    finally
                    {
                        settleOne();
                    }
                });
            };

            for (const boundary of initial)
            {
                drive(boundary);
            }
        },
        cancel(): void
        {
            // The consumer closed the controller. Set the latch and drop the abort listener,
            // or the caller's signal firing later runs `finish` against a controller that is
            // already closed - a throw inside the signal's dispatch, above every catch.
            closed = true;
            detachAbort?.();
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
