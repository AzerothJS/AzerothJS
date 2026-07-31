/**
 * MODULE: server/render-to-string
 *
 * Entry points for turning a component into an HTML string on the server. There is no DOM shim:
 * the render runs in 'string' mode (see azerothjs render-mode), where h() and the
 * control-flow components emit HTML directly instead of building DOM.
 *
 *   renderToString       - emits hydration markers (the co-range comment anchors and
 *                          reactive-hole `<!--[-->` anchors) so the client can adopt the markup
 *                          with hydrate().
 *   `{ markers: false }`  - emits clean HTML with no markers, for output that will never hydrate
 *                          (emails, static pages).
 *
 * For class-style components, pass a thunk that reads .element, e.g.
 * renderToString(() => new MyComponent(props).element).
 */

import { createRoot, runInMode, runInStoreScope, isSSRNode } from '../reactivity/index.ts';

/**
 * Renders `component` to an HTML string in 'string' mode with hydration markers toggled per
 * `markers` (scoped to the render window). Runs inside a fresh store scope per render for
 * per-request isolation.
 *
 * @internal
 * @param component - A thunk building the root element.
 * @param markers - Whether to emit hydration markers.
 * @returns The serialized HTML.
 */
function renderBody(component: () => HTMLElement | DocumentFragment, markers: boolean): string
{
    if (typeof component !== 'function')
    {
        throw new TypeError('renderToString expects a THUNK that builds the tree, e.g. '
            + 'renderToString(() => App(props)). It received an already-built value - the tree must '
            + 'build INSIDE the string-mode render, or h() runs against a missing server DOM.');
    }
    // Markers ride the mode window itself (exception-safe, render-scoped) - there is no
    // separate marker global to set and restore.
    return runInMode('string', (): string =>
        // A fresh store scope per render isolates createStore() state between concurrent
        // requests. Renders are synchronous, so one render's scope is set and restored before
        // another can start (see store-scope in azerothjs).
        runInStoreScope((): string =>
            // The tree builds inside a disposable ownership root, exactly as render()/
            // hydrate() establish client-side - a root component may provideContext()
            // (every router app does), which requires an owner. The tree is serialized
            // and dead by return, so the root disposes immediately.
            createRoot((dispose): string =>
            {
                try
                {
                    // In string mode, h()/components return an SSRNode cast to HTMLElement.
                    // Read its serialized html back out. A fragment-root component returns an ARRAY
                    // of SSRNodes; concatenate each one's html so a multi-node root serializes as its
                    // children (not the array's `[object Object],...` string form).
                    const node = component() as unknown;
                    if (Array.isArray(node))
                    {
                        return (node as unknown[]).map(n => isSSRNode(n) ? n.html : String(n)).join('');
                    }
                    return isSSRNode(node) ? node.html : String(node);
                }
                finally
                {
                    dispose();
                }
            })), { markers });
}

/** How {@link renderToString} shapes its output. */
export interface RenderToStringOptions
{
    /**
     * Emit the hydration markers {@link hydrate} adopts (default true).
     *
     * Set false for output that will never hydrate - an email, a feed, a static page, a PDF
     * source. The markup is then clean HTML with no framework bookkeeping in it.
     */
    markers?: boolean;
}

/**
 * renderToString
 *
 * PURPOSE:
 * Renders a component to body HTML on the server, with or without the anchors a hydrating client
 * needs to adopt the markup.
 *
 * WHY IT EXISTS:
 * SSR must emit HTML the client can revive without rebuilding it. Doing that by hand - `runInMode`
 * with the markers option, then digging the html off the returned SSRNode - is verbose and easy to
 * get subtly wrong; this is the one call.
 *
 * WHY ONE FUNCTION AND NOT TWO:
 * This used to be two exports, `renderToString` and `renderToStaticMarkup`, which were the same
 * private function called with `true` and `false`. Two names for one boolean is a choice every
 * reader has to make and can make wrongly - shipping marker-laden HTML into an email, or
 * marker-free HTML into a page that then fails to hydrate. The capability is kept; the second name
 * is not.
 *
 * INPUT CONTRACT:
 * - `component`: a THUNK that builds the root element. It must be a thunk, because the tree has to
 *   build while string mode is active.
 * - `options.markers`: whether to emit hydration anchors (default true).
 *
 * OUTPUT CONTRACT:
 * - Body HTML only. No `<html>`/`<head>` shell - that is {@link renderToDocument}'s job.
 *
 * WHY THIS DESIGN:
 * Markers ride the `runInMode` window, so they are render-scoped and exception-safe by
 * construction. The per-render store scope makes concurrent requests' `createStore()` state
 * independent, which is sound because an SSR render is synchronous: one scope is set and restored
 * before another can start.
 *
 * WHEN TO USE:
 * On the server, for any component you want as HTML.
 *
 * WHEN NOT TO USE:
 * On the client - use `render()`, which builds real DOM.
 *
 * EDGE CASES:
 * - A fragment-rooted component returns an array of nodes; their html is concatenated.
 * - Marker state is scoped to the render window, so a throwing render cannot leak it.
 * - Passing an already-built element instead of a thunk throws a named error rather than failing
 *   later against a missing DOM.
 *
 * PERFORMANCE NOTES:
 * A synchronous string build with no DOM allocation. Cost is proportional to the output size.
 *
 * @param component - A thunk that builds the root element.
 * @param options - Output shaping; see {@link RenderToStringOptions}.
 * @returns The serialized body HTML.
 * @see {@link renderToDocument} for a full document with a shell.
 * @example
 * // Hydration-ready, the default.
 * const page = renderToString(() => App({ user }));
 *
 * // Never hydrated: an email body, clean of framework markers.
 * const email = renderToString(() => Receipt({ order }), { markers: false });
 */
export function renderToString(component: () => HTMLElement | DocumentFragment, options: RenderToStringOptions = {}): string
{
    return renderBody(component, options.markers ?? true);
}
