/**
 * MODULE: renderer/namespace (internal) - which tags are foreign content, in one place
 *
 * SVG and MathML elements only paint when they are created in their own namespace. Two
 * code paths create elements from a tag name - h() builds them one at a time, tmpl()
 * parses a whole region as HTML text - and they must agree, or the SAME component renders
 * differently depending on which path the compiler chose for it (fresh client render goes
 * through tmpl, SSR and hydration through h). This module is the one place that knows.
 *
 * The rule is by TAG NAME rather than parent context because h() builds children before
 * their parent: there is no parent to consult. The known tag sets give every element in a
 * foreign subtree the right namespace independently.
 */

/** SVG / MathML namespace URIs. @internal */
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * SVG element tag names. A `<circle>`/`<path>`/`<svg>` built with the HTML
 * `createElement` lands in the XHTML namespace and the browser refuses to paint it
 * (no geometry, no styling), so these must be created with createElementNS(SVG_NS).
 * The four tags SVG shares with HTML (`a`, `script`, `style`, `title`) are deliberately
 * NOT listed: they are far more common as HTML, and an SVG `<a>`/`<title>` is rare.
 *
 * @internal
 */
const SVG_TAGS = new Set
([
    'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'foreignObject', 'marker', 'mask',
    'pattern', 'clipPath', 'filter', 'view', 'desc', 'metadata',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
    'textPath', 'image', 'animate', 'animateMotion', 'animateTransform', 'mpath', 'set',
    'linearGradient', 'radialGradient', 'stop', 'feBlend', 'feColorMatrix',
    'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
    'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
    'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
    'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
    'feSpotLight', 'feTile', 'feTurbulence'
]);

/** MathML element tag names; created with createElementNS(MATHML_NS) for the same reason. @internal */
const MATHML_TAGS = new Set
([
    'math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mfrac', 'msqrt',
    'mroot', 'mstyle', 'merror', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub',
    'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts', 'mtable',
    'mtr', 'mtd', 'maction', 'annotation', 'semantics'
]);

/**
 * The namespace a tag belongs to, or `null` for ordinary HTML.
 *
 * @param tag - The element tag name, spelled as authored (`foreignObject`, not lowercased).
 * @returns The namespace URI, or `null`.
 * @internal
 */
function namespaceOf(tag: string): string | null
{
    if (SVG_TAGS.has(tag))
    {
        return SVG_NS;
    }
    return MATHML_TAGS.has(tag) ? MATHML_NS : null;
}

/**
 * Creates a DOM element in the correct namespace for its tag. Plain `createElement`
 * always uses the XHTML namespace, which silently breaks SVG and MathML.
 *
 * @param tag - The element tag name.
 * @returns The created element, namespaced when the tag is SVG/MathML.
 * @internal
 */
export function createElementByTag(tag: string): HTMLElement
{
    const ns = namespaceOf(tag);
    return ns === null
        ? document.createElement(tag)
        : document.createElementNS(ns, tag) as unknown as HTMLElement;
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
export function parseContainerFor(tag: string): 'svg' | 'math' | null
{
    if (tag === 'svg' || tag === 'math')
    {
        return null;
    }
    const ns = namespaceOf(tag);
    return ns === SVG_NS ? 'svg' : ns === MATHML_NS ? 'math' : null;
}
