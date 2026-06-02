// Passthrough component used inside layouts to declare where the nested route's
// content goes. Sugar for props.children, with a discoverable name and reserved
// API space for future extensions (named outlets, transitions).
//
// <Routes> walks the matched root-to-leaf chain and renders
// Layout({ children: NextLevel({}) }), so every layout receives its children
// prop already populated. Inside the layout, the developer drops an <Outlet>
// wherever those children should appear:
//
//     const AppLayout: RouteComponent = ({ children }) =>
//         h('div', { class: 'app' },
//             h('header', {}, 'My App'),
//             h('main', {}, Outlet({ children }))
//         );
//
// <Outlet> reads props.children and returns it; if there are none (this layout
// is the leaf, no deeper level), it returns a display:contents placeholder so
// the surrounding DOM structure is preserved.
//
// Why a component instead of using props.children directly: discoverability
// (every router calls this <Outlet>, so it's what developers search for) and
// future expansion (named outlets, route transitions, and suspense fallbacks
// all want a named component as their entry point; reserving the API now keeps
// additions non-breaking).

/**
 * Props for the `<Outlet>` component.
 */
export interface OutletProps
{
    /**
     * The nested-route content to render. Provided automatically by `<Routes>`
     * via the layout component's `children` prop; the developer just forwards
     * it.
     */
    children?: HTMLElement;
}

/**
 * Renders the nested-route content inside a layout.
 *
 * @param props - `{ children? }`, typically forwarded straight from the
 *                surrounding layout component's props.
 *
 * @returns The children element if provided, or an invisible
 *          placeholder otherwise.
 *
 * Without Outlet: forwarding `children` straight into the layout breaks at the
 * leaf, where `children` is undefined, so you special-case it everywhere:
 *
 *     const AppLayout = ({ children }) =>
 *         h('main', {}, children ?? document.createElement('span'));
 *     // every layout repeats the undefined guard, easy to get wrong
 *
 * With Outlet: drop it in unconditionally; it returns the children when present
 * or an invisible placeholder otherwise:
 *
 *     const AppLayout = ({ children }) =>
 *         h('main', {}, Outlet({ children })); // always a valid element, no guard
 *
 * @example
 * ```ts
 * // A layout that places the nested level inside a <main>
 * const AppLayout: RouteComponent = ({ children }) =>
 *     h('div', { class: 'app' },
 *         h('nav', {}, '...'),
 *         h('main', {}, Outlet({ children }))
 *     );
 * ```
 *
 * @example
 * ```ts
 * // Used at the deepest layout: no further children, just an empty
 * // placeholder. Safe to use unconditionally.
 * Outlet({ children: undefined });  // -> empty <span style="display:contents">
 * ```
 */
export function Outlet(props: OutletProps): HTMLElement
{
    if (props.children)
    {
        return props.children;
    }

    // No nested level: return an invisible placeholder so the layout's DOM
    // structure stays intact and sibling layout logic doesn't need to
    // special-case "no outlet content".
    const placeholder = document.createElement('span');
    placeholder.style.display = 'contents';
    return placeholder;
}
