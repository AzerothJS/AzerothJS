// ============================================================================
// AZEROTHJS — Render Mode (Client / Server / Hydration Switch)
// ============================================================================
//
// The framework renders in one of three modes. The mode is a process-wide
// signal that h() and the control-flow components read at the top of every
// call to decide HOW to materialise their output:
//
//   'dom'      — the default. Build REAL DOM via document.createElement and
//                wire live reactive effects. This is the original behavior;
//                nothing about it changes.
//
//   'string'   — server-side rendering. Emit an HTML STRING instead of DOM:
//                no document, no live effects (reactive getters are read
//                exactly once). Used by @azerothjs/server's renderToString.
//
//   'hydrate'  — client-side adoption of server-rendered DOM. Walk the
//                existing nodes and attach listeners + effects in place
//                instead of creating new nodes.
//
// WHY THIS LIVES IN @azerothjs/reactivity (not @azerothjs/renderer):
//
//   Both the renderer (h, Show, For, …) AND the component package
//   (defineComponent, AzerothComponent, ErrorBoundary) must read the mode —
//   the renderer to pick a materialisation strategy, the component package
//   to skip onMount on the server. @azerothjs/component does NOT depend on
//   @azerothjs/renderer, so the only package beneath both is reactivity.
//
// The mode is a STACK so it nests and resets correctly: runInMode pushes on
// entry and pops in a finally, so a thrown render can never leak a non-'dom'
// mode into the next call (critical for a long-lived server process).
//
// ============================================================================

/**
 * The active rendering strategy. See the file header for the semantics of
 * each mode.
 */
export type RenderMode = 'dom' | 'string' | 'hydrate';

/**
 * Mode stack. The bottom is always `'dom'` (the default), so reading the
 * top outside any `runInMode` call yields `'dom'` — i.e. the original
 * client behavior.
 *
 * @internal
 */
const modeStack: RenderMode[] = ['dom'];

/**
 * Returns the currently active render mode (the top of the stack).
 *
 * @returns The active {@link RenderMode}; `'dom'` when no mode is pushed.
 */
export function getRenderMode(): RenderMode
{
    return modeStack[modeStack.length - 1];
}

/**
 * Whether the framework is currently emitting an HTML string (SSR).
 *
 * Hot-path predicate read at the top of `h()` and every control-flow
 * component.
 *
 * @returns `true` when the active mode is `'string'`.
 */
export function isStringMode(): boolean
{
    return getRenderMode() === 'string';
}

/**
 * Whether the framework is currently hydrating server-rendered DOM.
 *
 * @returns `true` when the active mode is `'hydrate'`.
 */
export function isHydrating(): boolean
{
    return getRenderMode() === 'hydrate';
}

/**
 * Runs `fn` with `mode` active, restoring the previous mode afterwards —
 * even if `fn` throws. Modes nest, so this is safe to call re-entrantly.
 *
 * @typeParam T - The return type of `fn`
 * @param mode - The mode to activate for the duration of `fn`
 * @param fn - The work to run in that mode
 *
 * @returns Whatever `fn` returns
 *
 * @example
 * ```ts
 * const html = runInMode('string', () => (App({}) as unknown as SSRNode).html);
 * ```
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
