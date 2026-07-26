// Tiny imperative DOM builders for the panel. The panel deliberately is NOT built with the
// framework it observes (the observer must not perturb the observed graph), so these helpers
// keep raw-DOM view code terse without pulling in any dependency.

/** Creates an element with a class list, optional text, and optional children. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = ''
): HTMLElementTagNameMap[K]
{
    const node = document.createElement(tag);
    if (className !== '')
    {
        node.className = className;
    }
    if (text !== '')
    {
        node.textContent = text;
    }
    return node;
}

/** An inline SVG icon from a path `d` (24x24 viewBox, stroked). */
export function icon(d: string): SVGSVGElement
{
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
}
