/**
 * MODULE: component/types
 *
 * Type contracts for @azerothjs/component.
 */

/**
 * A teardown callback stashed on a rendered element (via setDestroyHooks) and run by
 * destroyComponent() when the element's subtree is removed. Use it for NON-reactive,
 * node-bound cleanup (reactive effects are torn down by their owning createRoot).
 */
export type DestroyHook = () => void;
