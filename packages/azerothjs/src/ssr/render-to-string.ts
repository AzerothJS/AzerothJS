/**
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
 * Renders a component to body HTML, with or without the anchors a hydrating client needs.
 *
 * `component` MUST be a thunk, because the tree has to build while string mode is active.
 * Passing an already-built element throws a named error rather than failing later against a
 * missing DOM.
 *
 * There is deliberately no `renderToStaticMarkup` twin. Two names for one boolean is a choice
 * every reader has to make and can make wrongly - shipping marker-laden HTML into an email,
 * or marker-free HTML into a page that then fails to hydrate - so the capability rides the
 * `markers` option instead.
 *
 * Marker state is scoped to the render window, so a render that throws cannot leak it into
 * the next one. Each render also gets its own store scope, which is what keeps concurrent
 * requests' createStore state independent; that is sound precisely because an SSR render is
 * synchronous, so one scope is set and restored before another can begin.
 *
 * A fragment-rooted component returns several nodes, whose HTML is concatenated.
 *
 * @param component - A thunk building the root element.
 * @param options - Output shaping.
 * @param options.markers - Emit hydration anchors. Defaults to true.
 * @returns The body HTML. No `<html>` or `<head>` shell.
 * @throws {Error} If `component` is not a thunk.
 * @example
 * // Hydration-ready, the default.
 * const page = renderToString(() => App({ user }));
 *
 * // Never hydrated: an email body, clean of framework markers.
 * const email = renderToString(() => Receipt({ order }), { markers: false });
 *
 * @see {@link renderToDocument} for a full document.
 */
export function renderToString(component: () => HTMLElement | DocumentFragment, options: RenderToStringOptions = {}): string
{
    return renderBody(component, options.markers ?? true);
}
