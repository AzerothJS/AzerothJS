/**
 * MODULE: compiler/builtins - the built-in component tags the compiler knows about
 *
 * These tags are auto-imported from the runtime and given the runtime's own per-prop calling
 * convention (rather than the uniform user-component thunk contract). The list is shared by codegen
 * (to decide how to pass props) and the IR lowering (to mark a `component` binding `builtin: true`), so
 * every stage agrees on what counts as a built-in.
 *
 * @internal Compiler-internal tag table; not part of the package's public API.
 */

/** Built-in component tags the compiler auto-imports and treats specially. */
export const BUILTIN_COMPONENTS: readonly string[] =
    ['Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic', 'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'];

/** Set form of {@link BUILTIN_COMPONENTS} for O(1) "is this tag a built-in?" membership tests. */
export const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_COMPONENTS);
