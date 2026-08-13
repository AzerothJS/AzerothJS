/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Type contracts for the component runtime. */

/**
 * A teardown callback stashed on a rendered element (via setDestroyHooks) and run by
 * destroyComponent() when the element's subtree is removed. Use it for NON-reactive,
 * node-bound cleanup (reactive effects are torn down by their owning createRoot).
 */
export type DestroyHook = () => void;

/**
 * What a component or control-flow component returns on the client: a real element
 * (h() output) or a DocumentFragment (the marker-bracketed range a control-flow
 * component hands back - appending it moves the markers and content directly into
 * the real parent). Both are Nodes, so either can be mounted, appended, or nested
 * as a child. SSR and hydration return mode-specific descriptors cast through this
 * type at their documented mode boundaries.
 */
export type MountNode = HTMLElement | DocumentFragment;
