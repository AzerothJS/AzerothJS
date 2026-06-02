// Entry points for turning a component into an HTML string on the server.
// There is no DOM shim: the render runs in 'string' mode (see
// @azerothjs/reactivity's render-mode), where h() and the control-flow
// components emit HTML directly instead of building DOM.
//
//   renderToString       - emits hydration markers (data-azeroth-co wrappers
//                          and reactive-hole comment anchors) so the client can
//                          adopt the markup with hydrate().
//   renderToStaticMarkup - emits clean HTML with no markers, for output that
//                          will never be hydrated (emails, static pages).
//
// For class components, pass a thunk that reads .element, e.g.
//   renderToString(() => new MyComponent(props).element)

import { runInMode, setSSRMarkers, getSSRMarkers, isSSRNode } from '@azerothjs/reactivity';

/**
 * Renders `component` to an HTML string in `'string'` mode, with hydration
 * markers toggled per `markers`. Restores the previous marker setting
 * afterwards (so nested/sequential renders don't interfere).
 *
 * @example
 * ```ts
 * renderBody(() => h('p', {}, 'hi'), false);  // '<p>hi</p>'
 * renderBody(() => h('p', {}, 'hi'), true);   // marker-tagged variant
 * ```
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
 * Without renderToString: set 'string' mode yourself, run the component, then
 * dig the serialized html off the returned SSRNode and reset the markers:
 *
 *     setSSRMarkers(true);
 *     const node = runInMode('string', () => App({}));  // returns an SSRNode
 *     const html = node.html;
 *     setSSRMarkers(false);  // forget this and the next render leaks markers
 *
 * With renderToString: pass a thunk; it runs in string mode, toggles the
 * hydration markers, restores them, and returns the body HTML:
 *
 *     const html = renderToString(() => App({}));  // marker-tagged, hydration-ready
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
 * Renders a component to clean, marker-free HTML - for output that will not
 * be hydrated (transactional emails, fully static pages).
 *
 * Without renderToStaticMarkup: reach for renderToString and ship its
 * hydration bookkeeping into output that never hydrates:
 *
 *     const html = renderToString(() => EmailTemplate({ name }));
 *     // carries data-azeroth-co wrappers and comment anchors a mail client
 *     // will render as noise or strip unpredictably
 *
 * With renderToStaticMarkup: the same render with markers off, emitting plain
 * HTML:
 *
 *     const html = renderToStaticMarkup(() => EmailTemplate({ name }));
 *     // clean markup, no framework bookkeeping
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
