// ============================================================================
// AZEROTHJS — renderToString / renderToStaticMarkup
// ============================================================================
//
// The entry points for turning a component into an HTML STRING on the server.
// There is no DOM shim: the render runs in 'string' mode (see
// @azerothjs/reactivity's render-mode), where h() and the control-flow
// components emit HTML directly instead of building DOM.
//
//   renderToString       — emits hydration markers (data-azeroth-co wrappers
//                           and reactive-hole comment anchors) so the client
//                           can adopt the markup with hydrate().
//   renderToStaticMarkup — emits clean HTML with no markers, for output that
//                           will never be hydrated (emails, static pages).
//
// Class components: pass a thunk that reads `.element`, e.g.
//   renderToString(() => new MyComponent(props).element)
//
// ============================================================================

import { runInMode, setSSRMarkers, getSSRMarkers, isSSRNode } from '@azerothjs/reactivity';

/**
 * Renders `component` to an HTML string in `'string'` mode, with hydration
 * markers toggled per `markers`. Restores the previous marker setting
 * afterwards (so nested/sequential renders don't interfere).
 *
 * @internal
 */
function renderBody(component: () => HTMLElement, markers: boolean): string
{
    const previousMarkers = getSSRMarkers();
    setSSRMarkers(markers);

    try
    {
        return runInMode('string', (): string =>
        {
            // In string mode, h()/components return an SSRNode cast to
            // HTMLElement. Read its serialized html back out.
            const node = component() as unknown;
            return isSSRNode(node) ? node.html : String(node);
        });
    }
    finally
    {
        setSSRMarkers(previousMarkers);
    }
}

/**
 * Renders a component to an HTML string for the document body, including the
 * hydration markers that {@link hydrate} relies on.
 *
 * @param component - A thunk that builds the root element (e.g. `() => App({})`)
 * @returns The serialized body HTML
 *
 * @example
 * ```ts
 * const html = renderToString(() => App({ user }));
 * ```
 */
export function renderToString(component: () => HTMLElement): string
{
    return renderBody(component, true);
}

/**
 * Renders a component to clean, marker-free HTML — for output that will not
 * be hydrated (transactional emails, fully static pages).
 *
 * @param component - A thunk that builds the root element
 * @returns The serialized HTML with no framework bookkeeping
 *
 * @example
 * ```ts
 * const html = renderToStaticMarkup(() => EmailTemplate({ name }));
 * ```
 */
export function renderToStaticMarkup(component: () => HTMLElement): string
{
    return renderBody(component, false);
}
