// The framework renders in one of three modes. h() and the control-flow
// components read the active mode at the top of every call to decide how to
// materialise their output:
//
//   'dom'     - the default. Build real DOM via document.createElement and
//               wire live reactive effects.
//   'string'  - server-side rendering. Emit an HTML string instead of DOM: no
//               document, no live effects (reactive getters are read exactly
//               once). Used by @azerothjs/server's renderToString.
//   'hydrate' - client-side adoption of server-rendered DOM. Walk the existing
//               nodes and attach listeners and effects in place rather than
//               creating new ones.
//
// This lives in @azerothjs/reactivity rather than @azerothjs/renderer because
// both the renderer (h, Show, For) and the component package (defineComponent,
// ErrorBoundary) must read the mode, and @azerothjs/component does not depend
// on the renderer - reactivity is the only package beneath both.
//
// The mode is a stack so it nests and resets correctly: runInMode pushes on
// entry and pops in a finally, so a thrown render can never leak a non-'dom'
// mode into the next call - critical for a long-lived server process.

/**
 * The active rendering strategy. See the file header for the semantics of
 * each mode.
 */
export type RenderMode = 'dom' | 'string' | 'hydrate';

/**
 * Mode stack. The bottom is always `'dom'` (the default), so reading the top
 * outside any `runInMode` call yields `'dom'`, i.e. the original client
 * behavior.
 *
 * @internal
 */
const modeStack: RenderMode[] = ['dom'];

/**
 * Returns the currently active render mode (the top of the stack).
 *
 * @returns The active {@link RenderMode}; `'dom'` when no mode is pushed.
 *
 * @example
 * ```ts
 * getRenderMode(); // 'dom' outside any runInMode
 * runInMode('string', () => getRenderMode()); // 'string'
 * ```
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
 *
 * @example
 * ```ts
 * isStringMode(); // false in the default 'dom' mode
 * runInMode('string', () => isStringMode()); // true
 * ```
 */
export function isStringMode(): boolean
{
    return getRenderMode() === 'string';
}

/**
 * Whether the framework is currently hydrating server-rendered DOM.
 *
 * @returns `true` when the active mode is `'hydrate'`.
 *
 * @example
 * ```ts
 * isHydrating(); // false in the default 'dom' mode
 * runInMode('hydrate', () => isHydrating()); // true
 * ```
 */
export function isHydrating(): boolean
{
    return getRenderMode() === 'hydrate';
}

/**
 * Runs `fn` with `mode` active, restoring the previous mode afterwards, even
 * if `fn` throws. Modes nest, so this is safe to call re-entrantly.
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
