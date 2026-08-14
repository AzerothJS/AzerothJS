/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The passthrough a layout uses to declare WHERE its nested route's content goes.
 *
 * Routes walks the matched chain and renders `Layout({ children: NextLevel({}) })`, so every
 * layout already receives its children; the Outlet just marks the position. It is sugar for
 * `props.children` with a discoverable name and reserved API space - named outlets,
 * transitions, suspense - so those additions can arrive without breaking anything.
 *
 * At the leaf, where there are no children, it returns a `display: contents` placeholder so
 * the surrounding DOM layout is unaffected.
 */

import type { MountNode } from '../component/index.ts';

/**
 * Props for {@link Outlet}.
 */
export interface OutletProps
{
    /** The nested-route content; provided automatically by <Routes> via the layout's `children` prop, which the developer forwards. */
    children?: MountNode | undefined;
}

/**
 * Places the nested route's content inside a layout.
 *
 * A layout that omits it - or never places its `children` some other way - will not render
 * deeper route levels at all.
 *
 * It always returns a real element, so layouts never have to guard for the leaf case where
 * there is nothing deeper: that returns a `display: contents` placeholder, which leaves the
 * layout's DOM structure and sibling selectors unchanged either way.
 *
 * @param props - `children`, forwarded from the layout component's own props.
 * @returns The children, or an invisible placeholder.
 * @example
 * const AppLayout = ({ children }) => h('div', { class: 'app' },
 *     h('header', {}, 'My App'),
 *     h('main', {}, Outlet({ children }))
 * );
 *
 * @see {@link Routes}, which populates `children`.
 */
export function Outlet(props?: OutletProps): MountNode
{
    // The bare markup form lowers to a call with NO argument, and nothing in that position
    // can reach the layout's children - so it would place an empty region while the matched
    // leaf silently vanished. Refused instead, naming the spelling that works: a wrong page
    // that renders is far harder to diagnose than a call that stops.
    if (props === undefined)
    {
        throw new TypeError('Outlet was called with no props, which is what `<Outlet />` compiles to. '
            + 'A layout receives the nested route content as its OWN `children` prop and forwards it '
            + 'explicitly: `{ Outlet({ children: props.children }) }`.');
    }

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
