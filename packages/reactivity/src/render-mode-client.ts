/**
 * MODULE: reactivity/render-mode-client (internal)
 *
 * CLIENT-ONLY drop-in for ./render-mode.ts, substituted by the Vite plugin when the app compiles
 * with `ssr: false`. The mode getters return constants, so a minifier folds every
 * `if (isStringMode() || isHydrating())` branch in the runtime to dead code and the SSR/hydration
 * machinery those branches reference drops out of the bundle. Keep the export surface IDENTICAL
 * to ./render-mode.ts - the substitution is by module id, not by name.
 */

/** Mirror of ./render-mode.ts's RenderMode; only 'dom' ever occurs client-only. */
export type RenderMode = 'dom' | 'string' | 'hydrate';

/** Client-only build: the mode is always 'dom'. */
export function getRenderMode(): RenderMode
{
    return 'dom';
}

/** Client-only build: never string mode. */
export function isStringMode(): boolean
{
    return false;
}

/** Client-only build: never hydrating. */
export function isHydrating(): boolean
{
    return false;
}

/**
 * Client-only build: `renderToString`/`hydrate` cannot run (their mode switch is compiled out).
 * Throwing keeps a misconfigured app loud instead of silently rendering wrong.
 */
export function runInMode<T>(mode: RenderMode, fn: () => T): T
{
    if (mode !== 'dom')
    {
        throw new Error(`runInMode('${ mode }') is not available in a client-only build - remove \`ssr: false\` from the azeroth() plugin options.`);
    }
    return fn();
}
