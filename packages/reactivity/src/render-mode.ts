/**
 * MODULE: reactivity/render-mode
 *
 * The framework renders in one of three modes. h() and every control-flow component
 * read the active mode at the top of each call to decide how to materialise output:
 *
 *   'dom'     - default. Build real DOM (document.createElement) and wire live effects.
 *   'string'  - SSR. Emit an HTML string: no document, no live effects (reactive
 *               getters are read exactly once). Used by @azerothjs/server.
 *   'hydrate' - client adoption of server HTML. Walk existing nodes and attach
 *               listeners/effects in place instead of creating new ones.
 *
 * WHY IT LIVES IN @azerothjs/reactivity:
 * Both the renderer (h, Show, For) and @azerothjs/component (ErrorBoundary) must read
 * the mode, and component does not depend on the renderer - reactivity is the only
 * package beneath both, so the mode flag lives here.
 *
 * The mode is a STACK so it nests and resets correctly: runInMode pushes on entry and
 * pops in a finally, so a thrown render can never leak a non-'dom' mode into the next
 * call - essential for a long-lived server process serving many requests.
 */

/**
 * The active rendering strategy. See the module header for each mode's semantics.
 */
export type RenderMode = 'dom' | 'string' | 'hydrate';

/** Mode stack; the bottom is always 'dom', so reading the top outside runInMode is 'dom'. @internal */
const modeStack: RenderMode[] = ['dom'];

/**
 * getRenderMode
 *
 * PURPOSE:
 * Returns the currently active render mode (top of the mode stack).
 *
 * WHY IT EXISTS:
 * One read point for the mode lets every mode-aware primitive (h, control-flow,
 * ErrorBoundary) branch on a single source of truth instead of each tracking its own.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, render dispatch. Read at the top of h() and control-flow components to pick
 * DOM construction vs string serialization vs hydration adoption.
 *
 * INPUT CONTRACT:
 * - None.
 *
 * OUTPUT CONTRACT:
 * - The active {@link RenderMode}; 'dom' when no mode is pushed.
 *
 * WHY THIS DESIGN:
 * A stack (rather than a single mutable flag) is what makes nesting and exception-safe
 * restoration possible; this getter just reads its top.
 *
 * WHEN TO USE:
 * Inside render-time code that must behave differently per mode and needs the exact
 * mode (not just the string/hydrate booleans).
 *
 * WHEN NOT TO USE:
 * In application logic - app code should not branch on render mode.
 *
 * EDGE CASES:
 * - Outside any runInMode call it returns 'dom' (the stack bottom), i.e. plain client
 *   behavior.
 *
 * PERFORMANCE NOTES:
 * O(1): one array index read. It is on the render hot path, so it stays this cheap.
 *
 * DEVELOPER WARNING:
 * The value is only meaningful during a render; do not cache it across async
 * boundaries, where the active mode may have been popped.
 *
 * @returns The active {@link RenderMode}; 'dom' when no mode is pushed.
 * @see {@link runInMode}
 * @example
 * getRenderMode();                              // 'dom'
 * runInMode('string', () => getRenderMode());   // 'string'
 */
export function getRenderMode(): RenderMode
{
    // The stack bottom is permanent, but index math cannot prove it - the fallback IS
    // the documented outside-any-runInMode semantic.
    return modeStack[modeStack.length - 1] ?? 'dom';
}

/**
 * Whether the framework is currently emitting an HTML string (SSR). Hot-path predicate
 * read at the top of h() and control-flow components; delegates to {@link getRenderMode}.
 *
 * @returns true when the active mode is 'string'.
 * @see {@link runInMode}
 */
export function isStringMode(): boolean
{
    return getRenderMode() === 'string';
}

/**
 * Whether the framework is currently hydrating server-rendered DOM. Delegates to
 * {@link getRenderMode}.
 *
 * @returns true when the active mode is 'hydrate'.
 * @see {@link runInMode}
 */
export function isHydrating(): boolean
{
    return getRenderMode() === 'hydrate';
}

/**
 * runInMode
 *
 * PURPOSE:
 * Runs `fn` with `mode` active and restores the previous mode afterwards, even if `fn`
 * throws.
 *
 * WHY IT EXISTS:
 * It is the only sanctioned way to enter a non-'dom' mode. The server's renderToString
 * and the client's hydrate() wrap their work in it so the rest of the render tree reads
 * the right mode, and so the mode is guaranteed to reset when the work completes or
 * fails.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, render dispatch. The boundary that establishes string/hydrate mode for an
 * entire render subtree.
 *
 * INPUT CONTRACT:
 * - mode: the {@link RenderMode} to activate for the duration of fn.
 * - fn: the work to run in that mode.
 *
 * OUTPUT CONTRACT:
 * - Returns fn's return value. The previous mode is restored in a finally, so it is
 *   restored on both normal return and throw.
 *
 * WHY THIS DESIGN:
 * Push/pop on a stack (in try/finally) makes modes nest and self-heal: a render that
 * throws cannot leave a server stuck in 'string' mode for the next request.
 *
 * WHEN TO USE:
 * At an SSR or hydration entry point (or a test) that must run a subtree in a specific
 * mode.
 *
 * WHEN NOT TO USE:
 * In ordinary client rendering - 'dom' is already the default; wrapping needlessly only
 * adds a push/pop.
 *
 * EDGE CASES:
 * - Re-entrant/nested calls are safe; the inner pop restores to the outer mode.
 * - If fn throws, the mode is still popped before the throw propagates.
 *
 * PERFORMANCE NOTES:
 * O(1): one push and one pop around fn.
 *
 * DEVELOPER WARNING:
 * Do not push a mode by mutating the stack directly - always use runInMode, or the
 * finally-based restoration (and thus exception safety) is lost.
 *
 * @typeParam T - fn's return type.
 * @param mode - The mode to activate for the duration of fn.
 * @param fn - The work to run in that mode.
 * @returns Whatever `fn` returns.
 * @see {@link getRenderMode}
 * @example
 * const html = runInMode('string', () => (App({}) as unknown as SSRNode).html);
 */
export function runInMode<T>(mode: RenderMode, fn: () => T): T
{
    modeStack.push(mode);

    try
    {
        return fn();
    }
    finally
    {
        modeStack.pop();
    }
}
