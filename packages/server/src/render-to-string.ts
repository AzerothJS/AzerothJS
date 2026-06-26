/**
 * MODULE: server/render-to-string
 *
 * Entry points for turning a component into an HTML string on the server. There is no DOM shim:
 * the render runs in 'string' mode (see @azerothjs/reactivity render-mode), where h() and the
 * control-flow components emit HTML directly instead of building DOM.
 *
 *   renderToString       - emits hydration markers (the co-range comment anchors and
 *                          reactive-hole `<!--[-->` anchors) so the client can adopt the markup
 *                          with hydrate().
 *   renderToStaticMarkup - emits clean HTML with no markers, for output that will never hydrate
 *                          (emails, static pages).
 *
 * For class-style components, pass a thunk that reads .element, e.g.
 * renderToString(() => new MyComponent(props).element).
 */

import { runInMode, runInStoreScope, setSSRMarkers, getSSRMarkers, isSSRNode } from '@azerothjs/reactivity';

/**
 * Renders `component` to an HTML string in 'string' mode with hydration markers toggled per
 * `markers`, restoring the previous marker setting afterwards (so nested/sequential renders do
 * not interfere). Runs inside a fresh store scope per render for per-request isolation.
 *
 * @internal
 * @param component - A thunk building the root element.
 * @param markers - Whether to emit hydration markers.
 * @returns The serialized HTML.
 */
function renderBody(component: () => HTMLElement, markers: boolean): string
{
    const previousMarkers = getSSRMarkers();
    setSSRMarkers(markers);

    try
    {
        return runInMode('string', (): string =>
            // A fresh store scope per render isolates createStore() state between concurrent
            // requests. Renders are synchronous, so one render's scope is set and restored before
            // another can start (see store-scope in @azerothjs/reactivity).
            runInStoreScope((): string =>
            {
                // In string mode, h()/components return an SSRNode cast to HTMLElement. Read its
                // serialized html back out.
                const node = component() as unknown;
                return isSSRNode(node) ? node.html : String(node);
            }));
    }
    finally
    {
        setSSRMarkers(previousMarkers);
    }
}

/**
 * renderToString
 *
 * PURPOSE:
 * Renders a component to body HTML in string mode, including the hydration markers {@link hydrate}
 * relies on to adopt the markup on the client.
 *
 * WHY IT EXISTS:
 * SSR must emit HTML the client can revive without rebuilding. Doing it by hand (setSSRMarkers +
 * runInMode + digging the html off the returned SSRNode + resetting markers) is verbose and a
 * frequent source of leaked-marker state across renders. This is the one safe entry point.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, server; the SSR render entry. Runs the tree in runInMode('string') (no DOM, getters
 * read once, no live effects) inside a fresh store scope per render for per-request isolation.
 *
 * INPUT CONTRACT:
 * - component: a thunk building the root element (e.g. () => App({})). For class-style components
 *   pass () => new C(props).element.
 *
 * OUTPUT CONTRACT:
 * - The serialized BODY HTML with hydration markers. Pair with {@link renderToDocument} for a full
 *   document shell. The marker setting is restored afterwards (even on throw).
 *
 * WHY THIS DESIGN:
 * Save/restore of the marker flag keeps nested and sequential renders from interfering; the
 * per-render store scope makes concurrent requests' createStore() state independent, which is sound
 * because an SSR render is synchronous (one scope is set and restored before another can start).
 *
 * WHEN TO USE:
 * On the server, to render a page that the client will hydrate().
 *
 * WHEN NOT TO USE:
 * For never-hydrated output (use {@link renderToStaticMarkup}); on the client (use render()).
 *
 * EDGE CASES:
 * - Returns body HTML only - no <html>/<head> shell (that is renderToDocument's job).
 * - Markers are restored in a finally, so a throwing render does not leak the marker setting.
 *
 * PERFORMANCE NOTES:
 * A synchronous string build, no DOM allocation. Cost is proportional to the serialized output.
 *
 * DEVELOPER WARNING:
 * Pass a THUNK, not an already-built element (string mode must be active while the tree builds).
 * The output carries framework markers - do not ship it where it will not be hydrated.
 *
 * @param component - A thunk that builds the root element.
 * @returns The serialized, hydration-ready body HTML.
 * @see {@link renderToStaticMarkup}
 * @see {@link renderToDocument}
 * @example
 * const html = renderToString(() => App({ user }));
 */
export function renderToString(component: () => HTMLElement): string
{
    return renderBody(component, true);
}

/**
 * renderToStaticMarkup
 *
 * PURPOSE:
 * Renders a component to clean, marker-free HTML - for output that will not be hydrated
 * (transactional emails, fully static pages).
 *
 * WHY IT EXISTS:
 * renderToString ships hydration bookkeeping (co-range anchors, comment markers) that a mail
 * client renders as noise or strips unpredictably. Static output needs the same render WITHOUT
 * those markers.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, server; the static-HTML render entry. Identical to renderToString but with markers off.
 *
 * INPUT CONTRACT:
 * - component: a thunk building the root element.
 *
 * OUTPUT CONTRACT:
 * - Plain HTML with no framework bookkeeping. Not hydratable.
 *
 * WHEN TO USE:
 * For emails, static-site output, or any HTML that will never run hydrate().
 *
 * WHEN NOT TO USE:
 * For a page you intend to hydrate (use {@link renderToString}).
 *
 * PERFORMANCE NOTES:
 * Same as renderToString minus the marker emission.
 *
 * @param component - A thunk that builds the root element.
 * @returns The serialized HTML with no framework bookkeeping.
 * @see {@link renderToString}
 * @example
 * const html = renderToStaticMarkup(() => EmailTemplate({ name }));
 */
export function renderToStaticMarkup(component: () => HTMLElement): string
{
    return renderBody(component, false);
}
