/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The framework renders in one of three modes, read at the top of h() and every
 * control-flow component to decide how output is materialised:
 *
 *   'dom'     - the default. Build real DOM and wire live effects.
 *   'string'  - SSR. Emit HTML: no document, and no live effects, so a reactive getter is
 *               read exactly once.
 *   'hydrate' - client adoption of server HTML. Walk the existing nodes and attach
 *               listeners and effects in place rather than creating anything.
 *
 * The mode lives here, beneath both the renderer and the component layer, because both
 * must read it and the component layer does not depend on the renderer.
 *
 * It is a stack so it nests and resets correctly: runInMode pushes on entry and pops in a
 * finally, so a render that throws can never leak a non-'dom' mode into the next call -
 * essential in a long-lived server process serving many requests.
 */

import type { StreamSession } from './stream-session.ts';

/** The active rendering strategy. See the module header for each mode's semantics. */
export type RenderMode = 'dom' | 'string' | 'hydrate';

/**
 * One entry of the render-context stack: the mode plus the render-scoped flags riding with
 * it. Markers are part of the entry rather than a separate mutable global, so a render that
 * throws cannot leak marker state into the next request, and backing this stack with
 * per-async-context storage later would be a change to one accessor rather than a hunt for
 * scattered globals.
 */
interface ModeFrame
{
    mode: RenderMode;
    markers: boolean;
    session: StreamSession | null;
}

/** Empty means 'dom' with no markers. */
const frames: ModeFrame[] = [];

/**
 * One client adoption of a server-rendered tree.
 *
 * The stack above is exception-safe but SYNCHRONOUS, which is the right lifetime for a
 * serialization window and the wrong one for hydration: adoption can be outstanding after
 * the entry call returns. `<Routes>` is the case that proves it - a route whose chunk has
 * not landed claims nothing on its first effect run, and the re-run that finally adopts is
 * scheduled by the reactive system, long after hydrate()'s frame was popped. The re-run
 * then saw 'dom', built fresh DOM instead of an adoption descriptor, and left the server's
 * markup in place but wired to nothing.
 *
 * So a pass is an object with an explicit lifetime rather than a stack entry. It is OPEN
 * while adoption is still owed and terminal once it is not; a computation created during
 * an open pass re-enters it on re-run through {@link runInPass}, and once the pass closes those
 * same re-runs correctly see 'dom' again - adoption happens once, and later navigations
 * are ordinary DOM swaps.
 *
 * `pending` is what keeps an open pass from closing at the end of the synchronous window:
 * any site that must finish adopting later takes a {@link deferHydration} ticket first.
 *
 * @internal
 */
export interface HydrationPass
{
    /** False once adoption is finished or has failed; a closed pass is never re-entered. */
    open: boolean;

    /** Outstanding {@link deferHydration} tickets. The pass cannot close above zero. */
    pending: number;

    /**
     * Where a failure during DEFERRED adoption goes. Without it such a throw escapes as an
     * unhandled rejection, because the entry point's own catch returned with the frame -
     * which is why a deferred mismatch left an inert page while a synchronous one fell back
     * cleanly. hydrate() installs the same fallback it uses for the synchronous case.
     */
    onMismatch: ((error: unknown) => void) | null;
}

/** The pass being adopted right now, or null outside one. @internal */
let activePass: HydrationPass | null = null;

/**
 * The active pass, but only while it is still open. A closed pass is deliberately
 * indistinguishable from no pass, so a captured reference cannot resurrect adoption.
 */
function currentHydrationPass(): HydrationPass | null
{
    return activePass !== null && activePass.open ? activePass : null;
}

/**
 * Opens a pass. The caller drives it with {@link runInPass} and ends it with
 * {@link settleHydrationPass}.
 *
 * @internal
 * @param onMismatch - Handles a failure during deferred adoption.
 */
export function beginHydrationPass(onMismatch: (error: unknown) => void): HydrationPass
{
    return { open: true, pending: 0, onMismatch };
}

/**
 * Runs `fn` inside `pass` with 'hydrate' active. This is the re-entry point: the initial
 * window and every later resumption of the same pass go through here, so they are the same
 * code path rather than two that must be kept in step.
 *
 * A throw is routed to the pass's mismatch handler and CLOSES the pass, so a failed
 * adoption degrades to a clean client render instead of retrying against DOM that the
 * fallback is about to replace.
 *
 * @internal
 * @returns `fn`'s value, or undefined when the mismatch handler absorbed a throw.
 */
export function runInPass<T>(pass: HydrationPass, fn: () => T): T | undefined
{
    const previous = activePass;
    activePass = pass;
    try
    {
        return runInMode('hydrate', fn);
    }
    catch (error)
    {
        if (pass.onMismatch === null)
        {
            throw error;
        }
        pass.open = false;
        pass.onMismatch(error);
        return undefined;
    }
    finally
    {
        activePass = previous;
    }
}

/**
 * Takes a ticket saying "this region still owes adoption", keeping the pass open past the
 * end of the synchronous window and handing back the pass to resume under.
 *
 * The ticket holder is the ONLY code allowed to resume. An earlier version of this let
 * every computation born during the pass re-enter it, which is wrong in the other
 * direction: a `<Show>` that had already adopted its range re-ran while an unrelated route
 * was still waiting for its chunk, re-entered 'hydrate', and tried to adopt the same server
 * nodes twice. Authority to adopt belongs to whoever still owes adoption, not to everyone
 * who happened to be created while adoption was in progress.
 *
 * Call `release` once the region is adopted or abandoned; it is idempotent, and settles the
 * pass when the last ticket goes.
 *
 * @internal
 * @returns The pass and its release, or null when called outside an open pass.
 */
export function deferHydration(): { pass: HydrationPass; release: () => void } | null
{
    const pass = currentHydrationPass();
    if (pass === null)
    {
        return null;
    }

    pass.pending += 1;
    let released = false;
    return {
        pass,
        release: (): void =>
        {
            if (released)
            {
                return;
            }
            released = true;
            pass.pending -= 1;
            settleHydrationPass(pass);
        }
    };
}

/**
 * Closes the pass if nothing is outstanding. Called at the end of the entry window and
 * again as each ticket is released, so whichever finishes last is the one that closes it.
 *
 * @internal
 */
export function settleHydrationPass(pass: HydrationPass): void
{
    if (pass.pending === 0)
    {
        pass.open = false;
    }
}

/**
 * Whether hydration markers are active for this render: true only inside a
 * `runInMode('string', fn, { markers: true })` window. Read by the SSR serializers when
 * emitting hole and control-flow comment anchors.
 *
 * @internal
 */
export function ssrMarkersActive(): boolean
{
    return frames[frames.length - 1]?.markers ?? false;
}

/**
 * The streaming session of the current render window, or null for a buffered or client
 * render. Every serialization window is synchronous, so the session rides the frame stack
 * and needs no per-async-context storage.
 *
 * @internal
 */
export function currentStreamSession(): StreamSession | null
{
    return frames[frames.length - 1]?.session ?? null;
}

/** Options for {@link runInMode}. */
export interface RunInModeOptions
{
    /**
     * Emit hydration markers - hole anchors and control-flow ranges - while serializing.
     * Only meaningful in `'string'` mode. Omitted, it inherits the enclosing frame's
     * setting, so a nested mode switch inside one render keeps that render's choice; false
     * at the top level.
     */
    markers?: boolean;

    /**
     * The streaming session this window serializes under. Like `markers`, an omitted value
     * inherits the enclosing frame's; null at the top level.
     */
    session?: StreamSession | null;
}

/**
 * The active render mode, and 'dom' outside every {@link runInMode} call.
 *
 * Meaningful only during a render. Do not cache it across an async boundary, where the mode
 * that was active has since been popped. Application logic should not branch on it at all.
 *
 * @returns The active {@link RenderMode}.
 * @example
 * getRenderMode();                            // 'dom'
 * runInMode('string', () => getRenderMode()); // 'string'
 *
 * @see {@link runInMode}
 */
export function getRenderMode(): RenderMode
{
    return frames[frames.length - 1]?.mode ?? 'dom';
}

/**
 * Whether the framework is currently emitting an HTML string, which is the SSR path.
 *
 * @returns True when the active mode is `'string'`.
 */
export function isStringMode(): boolean
{
    return getRenderMode() === 'string';
}

/**
 * Whether the framework is currently adopting server-rendered DOM.
 *
 * @returns True when the active mode is `'hydrate'`.
 */
export function isHydrating(): boolean
{
    return getRenderMode() === 'hydrate';
}

/**
 * Runs `fn` with `mode` active, restoring the previous mode afterwards even if `fn` throws.
 * This is the only sanctioned way to enter a non-'dom' mode: the exception safety is what
 * stops a failed render from leaving a server stuck in `'string'` mode for the next request.
 *
 * Nesting is safe - the inner pop restores the outer mode.
 *
 * @typeParam T - `fn`'s return type.
 * @param mode - Active for the duration of `fn`.
 * @param fn - The work to run.
 * @param options - Render-scoped flags for this window.
 * @param options.markers - Emit hydration markers while serializing. Inherits the enclosing
 *                          frame when omitted.
 * @param options.session - The streaming session to serialize under. Inherits the enclosing
 *                          frame when omitted.
 * @returns Whatever `fn` returns.
 * @example
 * const html = runInMode('string', () => (App({}) as unknown as SSRNode).html, { markers: true });
 *
 * @see {@link getRenderMode}
 */
export function runInMode<T>(mode: RenderMode, fn: () => T, options?: RunInModeOptions): T
{
    frames.push({
        mode,
        markers: options?.markers ?? ssrMarkersActive(),
        session: options?.session !== undefined ? options.session : currentStreamSession()
    });

    try
    {
        return fn();
    }
    finally
    {
        frames.pop();
    }
}
