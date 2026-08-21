/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The render frame: one render window's head declarations and per-render css, as a VALUE
 * the window's host owns.
 *
 * Frame identity used to be the store scope, and the drains had no identity at all - two
 * copies of one module-global pattern in head.ts and css.ts. Neither survives contact
 * with the render model: a stream's main pass and every Suspense continuation share ONE
 * scope by design (scoped stores and the data cache's release key depend on it), so a
 * scope can never say WHICH window's frame this is; and a drain that reads a module
 * global by position serves whichever render armed it last, which is how one request's
 * head could be served inside another request's document.
 *
 * The model here: a render WINDOW (one buffered render, one stream main pass, one stream
 * continuation) writes to a frame. A host that wants exactness CONSTRUCTS the frame and
 * passes it in - it then holds it before the render runs, still holds it in a `finally`
 * when the render throws, and drains it whenever it likes; nothing else can reach it.
 * Writers find the live frame through a push/pop STACK - a discipline like
 * `runInStoreScope`'s, read only during the synchronous render body, never by a drain,
 * never counted, never consulted after a window closes.
 *
 * Windows have two exit policies. A buffered render or stream main pass POPS - the host
 * owns the frame - except that a window given NO frame seals into the LEGACY SLOT below
 * (top-level) or is discarded (nested: its writes are request-derived, and the slot is
 * module state that outlives the request). A stream continuation ALWAYS discards: the
 * head has already flushed, so nothing it declares can reach this response's document,
 * and it must never reach anyone else's.
 *
 * THE LEGACY SLOT serves the public zero-argument drains. It is a small, finite state
 * machine - occupancy x seal-state x per-payload consumption:
 *   - an un-migrated top-level window SEALS into it by overwriting an unsealed stray
 *     frame, or - if a sealed frame with any NON-EMPTY unconsumed payload is already
 *     outstanding - by clearing BOTH with a DEV diagnostic: fail-closed, never
 *     cross-serve;
 *   - each zero-argument drain consumes ITS OWN payload; the frame stays until both
 *     payloads are consumed, where an EMPTY payload counts as consumed (a styles-only
 *     host never strands an empty head payload into permanent ambiguity);
 *   - a stray write with no live window lands here too: unsealed when the slot was
 *     empty, appended when it held a frame - and an append to an already-consumed
 *     payload re-marks it unconsumed, because it holds new data.
 * The slot makes an un-migrated SYNCHRONOUS host byte-identical to before; it does not
 * make an un-migrated ASYNCHRONOUS host exact. Exactness comes from owning a frame.
 */

import { DEV } from '../reactivity/dev.ts';

/** @internal One head declaration as head.ts builds it; opaque here. */
type HeadEntryLike = unknown;

/**
 * One render window's collected head declarations and per-render css. Construct with
 * {@link createRenderFrame}, pass via the render options, and hand it to
 * `collectStyleSheet` / `collectHead` to drain exactly this render's output. The payload
 * fields are internal: the drains are the only readers.
 */
export class RenderFrame
{
    /** @internal Head declarations in registration order; head.ts owns the element type. */
    public headEntries: HeadEntryLike[] = [];

    /** @internal Scoped css by scope hash; css.ts owns both halves. */
    public css: Map<string, string> = new Map();
}

/** Creates the frame a render host owns: pass it to the render, then to the drains. */
export function createRenderFrame(): RenderFrame
{
    return new RenderFrame();
}

// --- the live-window stack -------------------------------------------------------------

const stack: RenderFrame[] = [];

/** @internal The live window's frame - the writers' one lookup. Null outside any window. */
export function currentFrame(): RenderFrame | null
{
    return stack.length === 0 ? null : (stack[stack.length - 1] as RenderFrame);
}

/** @internal What openRenderWindow hands back; closeRenderWindow needs all three facts. */
export interface RenderWindow
{
    frame: RenderFrame;
    owned: boolean;
    nested: boolean;
}

/**
 * Opens a buffered-render or stream-main-pass window. Called INSIDE the render's store
 * scope, never at the entry point: the entry scope and the body scope are different
 * objects, and an entry-installed identity is exactly the mistake this module retires.
 *
 * @internal
 */
export function openRenderWindow(hostFrame: RenderFrame | undefined): RenderWindow
{
    const window: RenderWindow = {
        frame: hostFrame ?? new RenderFrame(),
        owned: hostFrame !== undefined,
        nested: stack.length > 0
    };
    stack.push(window.frame);
    return window;
}

/**
 * Closes a buffered/main-pass window. Owned frames pop - and on a throw their payloads
 * clear, so a host that catches and renders an error page into the SAME frame cannot
 * compose the dead render's partial head into the error document. A zero-frame window
 * seals into the legacy slot only when TOP-LEVEL and SUCCESSFUL: nested windows discard
 * (their request-derived writes must not outlive the request in module state), and a
 * throw never seals (a naive finally must not arm the slot with a dead render's frame).
 *
 * @internal
 */
export function closeRenderWindow(window: RenderWindow, outcome: 'success' | 'throw'): void
{
    if (window.owned && outcome === 'throw')
    {
        // Clear BEFORE popping, per the contract's letter (unobservable single-threaded,
        // stated for conformance).
        clearPayloads(window.frame);
    }
    popFrame(window.frame);
    if (window.owned)
    {
        return;
    }
    if (window.nested || outcome === 'throw')
    {
        discardFrame(window.frame);
        return;
    }
    sealToSlot(window.frame);
}

/**
 * Opens a stream CONTINUATION's window. Its frame is created internally and handed to no
 * host - a continuation's declarations can never reach any document, so its window has
 * exactly one exit: {@link closeContinuationWindow} discards, success and throw alike.
 *
 * @internal
 */
export function openContinuationWindow(): RenderWindow
{
    const window: RenderWindow = { frame: new RenderFrame(), owned: false, nested: false };
    stack.push(window.frame);
    return window;
}

/** @internal The continuation's one exit: pop and discard, with the DEV diagnostics. */
export function closeContinuationWindow(window: RenderWindow): void
{
    popFrame(window.frame);
    discardFrame(window.frame);
}

/** Pops `frame` if it is the top; pop-safe when a reset emptied the stack mid-render. */
function popFrame(frame: RenderFrame): void
{
    if (stack.length > 0 && stack[stack.length - 1] === frame)
    {
        stack.pop();
    }
}

function clearPayloads(frame: RenderFrame): void
{
    frame.headEntries.length = 0;
    frame.css.clear();
}

/**
 * Drops a frame's payloads with the per-payload DEV diagnostics (only when non-empty -
 * an empty discard is routine, not a signal).
 */
function discardFrame(frame: RenderFrame): void
{
    if (DEV && frame.css.size > 0)
    {
        console.warn('azeroth: css`` evaluated inside a streamed Suspense continuation cannot reach the '
            + 'already-flushed document head; its rules were dropped for this response. Move the css`` '
            + 'call to the main pass, or use a style { } section (app-static).');
    }
    if (DEV && frame.headEntries.length > 0)
    {
        console.warn('azeroth: useHead() declarations could not reach this response\'s document head '
            + '(declared inside a streamed Suspense continuation, a nested render without a frame, or the '
            + 'render threw) and were dropped. Pass a RenderFrame through the render options to own them, '
            + 'derive SEO-critical facts from the route loader, or accept client-only application after hydration.');
    }
    clearPayloads(frame);
}

// --- the legacy slot -------------------------------------------------------------------

interface LegacySlot
{
    frame: RenderFrame;
    sealed: boolean;
    headConsumed: boolean;
    cssConsumed: boolean;
}

let slot: LegacySlot | null = null;

/** A payload is outstanding only when NON-EMPTY and unconsumed: empty counts as consumed. */
function outstanding(entry: LegacySlot): boolean
{
    return (entry.frame.headEntries.length > 0 && !entry.headConsumed)
        || (entry.frame.css.size > 0 && !entry.cssConsumed);
}

/**
 * The destination for a write with NO live window - reachable through public
 * `runInMode('string', ...)` with no render entry point. Creates the slot's frame
 * UNSEALED when empty; appends to whatever frame it holds otherwise, re-marking the
 * touched payload unconsumed (it holds new data).
 *
 * @internal
 */
export function strayWriteFrame(payload: 'head' | 'css'): RenderFrame
{
    if (slot === null)
    {
        slot = { frame: new RenderFrame(), sealed: false, headConsumed: false, cssConsumed: false };
    }
    if (payload === 'head')
    {
        slot.headConsumed = false;
    }
    else
    {
        slot.cssConsumed = false;
    }
    return slot.frame;
}

/** An un-migrated top-level window's SUCCESS exit: the zero-argument drains' source. */
function sealToSlot(frame: RenderFrame): void
{
    if (slot !== null && slot.sealed && outstanding(slot))
    {
        // Two sealed frames: fail closed. NEITHER reaches any document - the drop is the
        // security property, and cross-serving is unrepresentable.
        slot = null;
        if (DEV)
        {
            console.warn('azeroth: a second render sealed its head/style frame before the previous one was '
                + 'drained; BOTH were dropped. A zero-argument collectStyleSheet()/collectHead() serves one '
                + 'render at a time, synchronously - pass a RenderFrame through the render options to own '
                + 'each render\'s output exactly.');
        }
        return;
    }
    // An unsealed stray frame is overwritten silently (a stray write lost to a real
    // render is the pre-existing rotation semantics); a fully-consumed sealed frame has
    // already left the slot at its final drain.
    slot = { frame, sealed: true, headConsumed: false, cssConsumed: false };
}

function releaseSlotIfDone(): void
{
    if (slot !== null
        && (slot.headConsumed || slot.frame.headEntries.length === 0)
        && (slot.cssConsumed || slot.frame.css.size === 0))
    {
        slot = null;
    }
}

/** @internal The zero-argument collectHead's source: consumes the slot's head payload. */
export function takeSlotHead(): HeadEntryLike[] | null
{
    if (slot === null)
    {
        return null;
    }
    const entries = slot.frame.headEntries;
    slot.headConsumed = true;
    releaseSlotIfDone();
    return entries;
}

/** @internal The zero-argument collectStyleSheet's source: consumes the css payload. */
export function takeSlotCss(): Map<string, string> | null
{
    if (slot === null)
    {
        return null;
    }
    const css = slot.frame.css;
    slot.cssConsumed = true;
    releaseSlotIfDone();
    return css;
}

/**
 * resetStyleSheet's frame half: clears the css payload ONLY - the head payload belongs to
 * resetHead - and diagnoses a mid-render call, the documented rare-server shape.
 *
 * @internal
 */
export function resetSlotCss(): void
{
    if (DEV && stack.length > 0)
    {
        console.warn('azeroth: resetStyleSheet() was called during a render; the live render window keeps '
            + 'its frame, and only the legacy slot\'s css was cleared.');
    }
    if (slot !== null)
    {
        slot.frame.css.clear();
        releaseSlotIfDone();
    }
}

/** @internal resetHead is the suite's between-tests hammer: stack and slot both go. */
export function resetAllFrames(): void
{
    stack.length = 0;
    slot = null;
}
