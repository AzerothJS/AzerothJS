/**
 * MODULE: reactivity/dev
 *
 * The ONE development-mode gate for the runtime. Computed once at module load, off `globalThis`
 * so browsers without a `process` global read `undefined` and land on the DEV side.
 *
 * This is a RUNTIME gate, deliberately: the package ships plain readable module output with no
 * compile-time constant replacement, so the branch travels into the published files and costs one
 * boolean check. It is NOT foldable by a bundler's `define` of `process.env.NODE_ENV` - that
 * replacement matches the bare token, never a `globalThis` probe - so nothing here claims to
 * disappear from a production bundle. What production gets is the BEHAVIOR switch: diagnostics,
 * warnings, and their supporting probes run only when DEV is true.
 *
 * @internal Not exported from any public entry.
 */

/** True outside `NODE_ENV=production` - including browsers with no `process` at all. */
export const DEV: boolean =
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== 'production';
