/**
 * The client-only drop-in for ./render-mode.ts, substituted by the Vite plugin when an app
 * compiles with `ssr: false`. Every mode getter returns a constant, so a minifier folds the
 * runtime's `isStringMode()` and `isHydrating()` branches to dead code and the SSR and
 * hydration machinery behind them leaves the bundle.
 *
 * Keep the export surface IDENTICAL to ./render-mode.ts: the substitution is by module id,
 * so a missing export here becomes a runtime failure in a client-only build only.
 */

/** Mirrors ./render-mode.ts. Only 'dom' ever occurs in a client-only build. */
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

/** Client-only build: markers are an SSR concern that never arises. */
export function ssrMarkersActive(): boolean
{
    return false;
}

/** Client-only build: no streaming session ever exists. */
export function currentStreamSession(): null
{
    return null;
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
