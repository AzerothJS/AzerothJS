// ============================================================================
// AZEROTHJS — <Outlet>
// ============================================================================
//
// Tiny passthrough component used inside layouts to declare WHERE
// the nested route's content goes. Sugar for `props.children`,
// with a discoverable name and reserved API space for future
// extensions (named outlets, transitions, …).
//
// HOW IT FITS:
//
//   `<Routes>` walks the matched root → leaf chain and renders
//   `Layout({ children: NextLevel({}) })` — every layout receives
//   its `children` prop already populated. Inside the layout, the
//   developer drops an `<Outlet>` wherever those children should
//   appear:
//
//     const AppLayout: RouteComponent = ({ children }) =>
//         h('div', { class: 'app' },
//             h('header', {}, 'My App'),
//             h('main', {}, Outlet({ children }))
//         );
//
//   That's the whole pattern. `<Outlet>` reads `props.children`
//   and returns it; if there are no children (i.e. this layout
//   IS the leaf, no deeper level), it returns a `display: contents`
//   placeholder so the surrounding DOM structure is preserved.
//
// WHY NOT JUST USE `props.children` DIRECTLY?
//
//   You can — `<Outlet>` is genuinely just sugar. The reason it
//   exists:
//
//     1. Discoverability. Every router calls this thing
//        `<Outlet>` (Solid, React Router, Vue Router). Saying
//        "use `<Outlet>`" is what developers will search for.
//
//     2. Future expansion. Multiple named outlets, route
//        transitions, suspense fallbacks — they all want a
//        named component as their entry point. Reserving the
//        API now keeps additions non-breaking.
//
// ============================================================================

/**
 * Props for the `<Outlet>` component.
 */
export interface OutletProps
{
    /**
     * The nested-route content to render. Provided automatically
     * by `<Routes>` via the layout component's `children` prop —
     * the developer just forwards it.
     */
    children?: HTMLElement;
}

/**
 * Renders the nested-route content inside a layout.
 *
 * @param props - `{ children? }` — typically forwarded straight
 *                from the surrounding layout component's props.
 *
 * @returns The children element if provided, or an invisible
 *          placeholder otherwise.
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
 * // Used at the deepest layout — no further children, just an
 * // empty placeholder. Safe to use unconditionally.
 * Outlet({ children: undefined });  // → empty <span style="display:contents">
 * ```
 */
export function Outlet(props: OutletProps): HTMLElement
{
    if (props.children) return props.children;

    // No nested level — return an invisible placeholder so the
    // layout's DOM structure stays intact and any sibling layout
    // logic doesn't need to special-case "no outlet content".
    const placeholder = document.createElement('span');
    placeholder.style.display = 'contents';
    return placeholder;
}
