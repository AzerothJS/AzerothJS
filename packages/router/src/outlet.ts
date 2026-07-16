/**
 * MODULE: router/outlet
 *
 * <Outlet> is the passthrough component used inside a layout to declare WHERE the nested route's
 * content goes. <Routes> walks the matched root-to-leaf chain and renders
 * Layout({ children: NextLevel({}) }), so every layout receives its `children` already populated;
 * inside the layout the developer drops an <Outlet> wherever those children should appear. It is
 * sugar for props.children with a discoverable name and reserved API space (named outlets,
 * transitions, suspense) so future additions stay non-breaking. When there are no children (the
 * leaf layout), it returns a display:contents placeholder so the surrounding DOM stays intact.
 */

import type { MountNode } from '@azerothjs/component';

/**
 * Props for {@link Outlet}.
 */
export interface OutletProps
{
    /** The nested-route content; provided automatically by <Routes> via the layout's `children` prop, which the developer forwards. */
    children?: MountNode | undefined;
}

/**
 * Outlet
 *
 * PURPOSE:
 * Renders the nested-route content inside a layout: returns `children` when present, or an
 * invisible placeholder when this layout is the leaf (no deeper level).
 *
 * WHY IT EXISTS:
 * Forwarding `children` straight into a layout breaks at the leaf, where `children` is undefined,
 * so every layout would special-case the undefined guard. Outlet centralizes that (always returns
 * a valid element) and gives the placement a discoverable, future-proof name.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; a thin layout helper. <Routes>/renderChain populate `children`; Outlet just
 * places it.
 *
 * INPUT CONTRACT:
 * - children: the nested content, typically forwarded straight from the layout component's props.
 *
 * OUTPUT CONTRACT:
 * - The children element when provided, else a `<span style="display:contents">` placeholder.
 *
 * WHY THIS DESIGN:
 * Returning a real element unconditionally (placeholder when empty) means layouts never guard for
 * undefined, and the display:contents placeholder keeps the layout's DOM structure and sibling
 * logic unchanged whether or not there is a deeper level.
 *
 * WHEN TO USE:
 * Inside any layout route, at the position where the nested route should render.
 *
 * WHEN NOT TO USE:
 * Outside a layout/route context (there is no children to place).
 *
 * EDGE CASES:
 * - No children (leaf layout) returns an empty display:contents span, safe to use unconditionally.
 *
 * PERFORMANCE NOTES:
 * O(1): returns the existing children element or allocates one placeholder span.
 *
 * DEVELOPER WARNING:
 * A layout that omits <Outlet> (or otherwise never places its `children`) will not render deeper
 * route levels at all.
 *
 * @param props - {@link OutletProps}: `children` (forwarded from the layout).
 * @returns The children element, or an invisible placeholder.
 * @see {@link Routes}
 * @example
 * const AppLayout = ({ children }) =>
 *   h('div', { class: 'app' }, h('header', {}, 'My App'), h('main', {}, Outlet({ children })));
 */
export function Outlet(props: OutletProps): MountNode
{
    if (props.children)
    {
        return props.children;
    }

    // No nested level: return an invisible placeholder so the layout's DOM structure stays intact
    // and sibling layout logic does not need to special-case "no outlet content".
    const placeholder = document.createElement('span');
    placeholder.style.display = 'contents';
    return placeholder;
}
