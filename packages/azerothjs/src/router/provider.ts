/**
 * MODULE: router/provider - the context that lets composables drop the router argument
 *
 * `<RouterProvider router={router}>` publishes the router on the ownership tree
 * (createContext); every composable (`useRoute`, `useParams`, `useLoader`, ...) and
 * component (`Link`, `Routes`, `Outlet`) resolves it from there when no explicit router
 * is passed. The explicit-argument forms REMAIN as overrides - tests and nested routers
 * keep working - so adopting the provider only ever deletes an argument.
 *
 * Beside the owner-based router context lives a CONSTRUCTION-TIME level frame:
 * `<Routes>` wraps each chain level's component call in `withRouteLevel(router, i)`, so
 * a `useLoader()` call in a component body knows which level's resource it means without
 * threading indexes through props. The frame is synchronous by design - composables are
 * called during component construction (the same rule every hook system has); the
 * OBJECTS they return (resources, getters) stay live afterwards.
 */

import { createContext, provideContext, useContext } from '../reactivity/index.ts';
import type { MountNode } from '../component/index.ts';
import type { Router } from './router.ts';

/** @internal The owner-tree slot RouterProvider publishes on. */
const ROUTER_CONTEXT = createContext<Router>(undefined, 'router');

/** Props for {@link RouterProvider}. */
export interface RouterProviderProps
{
    /** The router to publish to every descendant composable and router component. */
    router: Router;

    /** The subtree that may now call `useRoute()` etc. without arguments. */
    children?: MountNode | (() => MountNode);
}

/**
 * RouterProvider
 *
 * PURPOSE:
 * Publishes `router` on the ownership tree so descendants resolve it from context:
 * `useRoute()` instead of `useRoute(router)`, `Link({ to })` instead of
 * `Link({ to, router })`.
 *
 * WHY IT EXISTS:
 * Threading the router through every call was the v1 shape; the composables' docs
 * promised the context evolution ("only the call drops the router argument") - this
 * component is that promise kept, before 1.0 freezes call shapes.
 *
 * INPUT CONTRACT:
 * - Must run inside an ownership scope (render() provides one) - provideContext throws
 *   outside one, loudly.
 * - `children` may be the usual lazy thunk (compiled `.azeroth` children holes) or an
 *   eager MountNode; only thunked/compiled children constructed AFTER this component
 *   body can see the context (eager children were already built - pass a thunk when
 *   composing manually with h()).
 *
 * @example
 * render(() => RouterProvider({ router, children: () => App({}) }), document.body);
 */
export function RouterProvider(props: RouterProviderProps): MountNode
{
    provideContext(ROUTER_CONTEXT, props.router);
    const children = props.children;
    return (typeof children === 'function' ? children() : children) as MountNode;
}

/**
 * @internal The router for a composable/component call: the explicit argument when
 * given, else the construction-time route frame's router (inside a `<Routes>` chain),
 * else the nearest `<RouterProvider>`. Throws a call-site-named error when none exists.
 */
export function resolveRouter(explicit: Router | undefined, caller: string): Router
{
    if (explicit !== undefined)
    {
        return explicit;
    }
    if (levelFrame !== null)
    {
        return levelFrame.router;
    }
    const provided = useContext(ROUTER_CONTEXT);
    if (provided !== undefined)
    {
        return provided;
    }
    throw new Error(`${ caller }() found no router: pass one explicitly (${ caller }(router)) `
        + 'or wrap the tree in <RouterProvider router={router}>.');
}

/** @internal The active construction-time frame: which router + chain level is building. */
interface RouteFrame
{
    router: Router;
    level: number;
}

let levelFrame: RouteFrame | null = null;

/**
 * @internal Runs `build` (one chain level's component construction) under a route
 * frame, so `useLoader()`/`useSearch()` calls inside the component body resolve this
 * level. Restores the previous frame on exit - nested `<Routes>` (a sub-router inside
 * a route) stack correctly.
 */
export function withRouteLevel<T>(router: Router, level: number, build: () => T): T
{
    const previous = levelFrame;
    levelFrame = { router, level };
    try
    {
        return build();
    }
    finally
    {
        levelFrame = previous;
    }
}

/**
 * @internal The construction-time route frame, consulted by `useLoader`/`useSearch`
 * to resolve "my level" with no arguments. Null outside a `<Routes>` chain build.
 */
export function currentRouteFrame(): RouteFrame | null
{
    return levelFrame;
}
