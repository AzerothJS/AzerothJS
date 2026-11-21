/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The context that lets composables drop their router argument.
 *
 * `<RouterProvider router={router}>` publishes the router on the ownership tree, and every
 * composable and router component resolves it from there when none is passed explicitly. The
 * explicit forms remain as overrides, so tests and nested routers keep working and adopting
 * the provider only ever deletes an argument.
 *
 * Each mounted routed segment also supplies its presentation and level. An owned effect,
 * deferred child or placed outlet can resolve them after component construction returns.
 */

import { componentScope, createContext, getOwner, provideContext, useContext } from '../reactivity/index.ts';
import type { MountNode } from '../component/index.ts';
import type { Router } from './router.ts';
import type { RouteFrame } from './segment-owner.ts';

/** @internal The owner-tree slot RouterProvider publishes on. */
const ROUTER_CONTEXT = createContext<{ router: Router; frame: RouteFrame | null }>(undefined, 'router');

/** Props for {@link RouterProvider}. */
export interface RouterProviderProps
{
    /** The router to publish to every descendant composable and router component. */
    router: Router;

    /** The subtree that may now call `useRoute()` etc. without arguments. */
    children?: MountNode | (() => MountNode);
}

/**
 * Publishes `router` on the ownership tree, so descendants resolve it from context:
 * `useRoute()` rather than `useRoute(router)`, `Link({ to })` rather than
 * `Link({ to, router })`.
 *
 * Must run inside an ownership scope, which render() provides; outside one, providing the
 * context throws loudly.
 *
 * `children` may be a lazy thunk, as compiled markup produces, or an eager node. Only
 * children constructed AFTER this component body can see the context - an eager child was
 * already built - so pass a thunk when composing manually.
 *
 * @example
 * render(() => RouterProvider({ router, children: () => App({}) }), document.body);
 */
export function RouterProvider(props: RouterProviderProps): MountNode
{
    if (getOwner() === null)
    {
        throw new Error('RouterProvider() requires an ownership scope. Render inside a component or createRoot().');
    }
    const inherited = currentRouteFrame();
    return componentScope(() =>
    {
        provideContext(ROUTER_CONTEXT, { router: props.router, frame: inherited?.router === props.router ? inherited : null });
        const children = props.children;
        return (typeof children === 'function' ? children() : children) as MountNode;
    });
}

export function resolveRouter(explicit: Router | undefined, caller: string): Router
{
    const router = explicit ?? useContext(ROUTER_CONTEXT)?.router;
    if (router !== undefined)
    {
        return router;
    }
    throw new Error(`${ caller }() found no router: pass one explicitly (${ caller }(router)) `
        + 'or wrap the tree in <RouterProvider router={router}>.');
}

/** Provides the segment only within this build, including its delayed descendants. */
export function withRouteFrame<T>(frame: RouteFrame, build: () => T): T
{
    return componentScope(() =>
    {
        provideContext(ROUTER_CONTEXT, { router: frame.router, frame });
        return build();
    });
}

export function currentRouteFrame(): RouteFrame | null
{
    return useContext(ROUTER_CONTEXT)?.frame ?? null;
}
