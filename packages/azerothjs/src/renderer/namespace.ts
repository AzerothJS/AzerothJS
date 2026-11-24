/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { hostNamespaceForTag } from '../semantics.ts';
import type { HostNamespace } from '../semantics.ts';

/** DOM namespace URIs indexed by the compiler's markup context. */
export const NAMESPACE_URIS: Readonly<Record<HostNamespace, string>> = {
    html: 'http://www.w3.org/1999/xhtml',
    svg: 'http://www.w3.org/2000/svg',
    math: 'http://www.w3.org/1998/Math/MathML'
};

/**
 * Creates a DOM element in the correct namespace for its tag. Plain `createElement`
 * always uses the XHTML namespace, which silently breaks SVG and MathML.
 *
 * @param tag - The element tag name.
 * @returns The created element, namespaced when the tag is SVG/MathML.
 * @internal
 */
export function createElementByTag(tag: string, namespace: HostNamespace = hostNamespaceForTag(tag)): HTMLElement
{
    return namespace === 'html'
        ? document.createElement(tag)
        : document.createElementNS(NAMESPACE_URIS[namespace], tag) as unknown as HTMLElement;
}

/**
 * The element name a template's HTML must be parsed INSIDE for its root to land in the
 * right namespace, or `null` when plain HTML parsing is already correct.
 *
 * The HTML fragment parser applies foreign-content rules only once it has entered an
 * `<svg>`/`<math>` element, so a template whose root is an SVG CHILD (`<g>`, `<path>` -
 * exactly what a `<For>` row or a nested region serializes to) parses as an unknown HTML
 * element and never paints. Parsing it inside its container fixes that; a root that IS
 * `<svg>`/`<math>` needs no wrapper because the parser enters foreign content on its own.
 *
 * @param tag - The template root's tag name.
 * @returns `'svg'`, `'math'`, or `null`.
 * @internal
 */
export function parseContainerFor(tag: string, namespace: HostNamespace = hostNamespaceForTag(tag)): 'svg' | 'math' | null
{
    if (namespace === 'html' || namespace === tag.toLowerCase())
    {
        return null;
    }
    return namespace;
}
