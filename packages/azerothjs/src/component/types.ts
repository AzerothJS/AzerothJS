import type { Child } from '../renderer/types.ts';

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
/**
 * What a component renders, and what `render`/`hydrate` mount.
 *
 * The ARRAY form is a FRAGMENT root. It is not a convenience: `<>...</>` is normative grammar
 * (GRAMMAR.md 6), the compiler emits a fragment as a JS array from BOTH backends (codegen and
 * the projection), and the compiler's own multiple-root diagnostic tells authors to wrap
 * sibling roots in one. Typing it out meant the recommended fix did not type-check, and the
 * implementation had to cast past its own signature to iterate what it was really handed.
 *
 * Members are {@link Child} because a fragment's children are ordinary children - the compiler
 * emits static text among them as a plain string, not a Text node.
 */
export type MountNode = HTMLElement | DocumentFragment | Child[];
