/**
 * The one development-mode gate for the runtime, computed at module load off `globalThis` so
 * a browser with no `process` reads `undefined` and lands on the DEV side.
 *
 * Deliberately a RUNTIME gate. The package ships plain readable modules with no compile-time
 * constant replacement, so the branch travels into the published files and costs one boolean
 * check. A bundler's `define` of `process.env.NODE_ENV` will not fold it either, since that
 * replacement matches the bare token and not a `globalThis` probe. What production gets is
 * the behaviour switch, not dead-code elimination: diagnostics, warnings and their
 * supporting probes run only when DEV is true.
 *
 * @internal Not exported from any public entry.
 */

/** True outside `NODE_ENV=production` - including browsers with no `process` at all. */
export const DEV: boolean =
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
