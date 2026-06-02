// The DOM-free half of server-side rendering. These helpers build HTML
// strings without ever touching `document`, so they run on a bare server.
// Element-specific serialization (tag names, void elements, attribute rules)
// lives in @azerothjs/renderer's ssr.ts; the pieces here are the ones the
// component package also needs (ErrorBoundary serializes its children, and
// every control-flow component wraps its output in a contents span), which is
// why they sit in reactivity - the only package beneath both renderer and
// component.
//
// The SSRNode wrapper: in string mode, h() returns an SSRNode (cast to
// HTMLElement) rather than a real element. It carries already-serialized,
// already-escaped HTML plus a brand, so serializers can tell finished element
// markup apart from user text that still needs escaping.
//
// Hydration markers: when on (renderToString), reactive holes are wrapped in
// paired comment anchors `<!--[-->...<!--]-->` and control-flow wrappers carry
// a `data-azeroth-co` attribute, so the client hydrator can locate the exact
// nodes a getter owns. When off (renderToStaticMarkup) the output is clean
// HTML with no framework bookkeeping.

import { untrack } from './untrack.ts';

/**
 * A serialized node produced in `'string'` render mode. `html` is fully
 * serialized and already HTML-escaped; the `__ssr` brand lets
 * {@link isSSRNode} distinguish it from raw user text.
 */
export interface SSRNode
{
    readonly __ssr: true;
    html: string;
}

/**
 * Whether `x` is an {@link SSRNode} (finished markup) rather than a
 * primitive child needing escaping.
 *
 * @param x - Any value
 * @returns `true` if `x` is an SSRNode
 *
 * @example
 * ```ts
 * isSSRNode(ssr('<p>hi</p>')); // true
 * isSSRNode('hello');          // false (raw text needing escaping)
 * ```
 */
export function isSSRNode(x: unknown): x is SSRNode
{
    return typeof x === 'object' && x !== null && (x as { __ssr?: unknown }).__ssr === true;
}

/**
 * Wraps already-serialized HTML in an {@link SSRNode}.
 *
 * @param html - Finished, escaped HTML markup
 * @returns The branded node
 *
 * @example
 * ```ts
 * const node = ssr('<p>hi</p>');
 * node.html;        // '<p>hi</p>'
 * isSSRNode(node);  // true
 * ```
 */
export function ssr(html: string): SSRNode
{
    return { __ssr: true, html };
}

/**
 * Whether hydration markers are currently emitted. Toggled by
 * {@link setSSRMarkers}; defaults to OFF so a stray serialization (or
 * `renderToStaticMarkup`) produces clean HTML.
 *
 * @internal
 */
let markersOn = false;

/**
 * Turns hydration markers on or off for subsequent serialization.
 * `renderToString` enables them; `renderToStaticMarkup` disables them.
 *
 * @param on - Whether to emit `data-azeroth-co` attributes and `<!--[-->`
 *             reactive-hole anchors
 */
export function setSSRMarkers(on: boolean): void
{
    markersOn = on;
}

/**
 * Whether hydration markers are currently being emitted.
 *
 * @returns `true` when markers are on
 */
export function getSSRMarkers(): boolean
{
    return markersOn;
}

/**
 * Escapes a string for use as HTML TEXT content: `&`, `<`, `>`.
 *
 * @param value - Raw text
 * @returns Escaped text safe to place between tags
 *
 * @example
 * ```ts
 * escapeText('a < b & c'); // 'a &lt; b &amp; c'
 * ```
 */
export function escapeText(value: string): string
{
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes a string for use inside a double-quoted HTML ATTRIBUTE value:
 * `&`, `"`, `<`, `>`.
 *
 * @param value - Raw attribute value
 * @returns Escaped value safe inside `"..."`
 *
 * @example
 * ```ts
 * escapeAttr('say "hi" & <bye>'); // 'say &quot;hi&quot; &amp; &lt;bye&gt;'
 * ```
 */
export function escapeAttr(value: string): string
{
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Serializes a single child value to an HTML string. Mirrors the child
 * handling in h()'s `appendChild` so SSR output structurally matches what the
 * DOM path would build (important for hydration alignment):
 *
 *   - `null` / `undefined` / `false`: empty string (skipped)
 *   - {@link SSRNode}: its already-serialized `html`
 *   - array: each item serialized and concatenated
 *   - function (reactive hole): evaluated once via {@link untrack} (never
 *     subscribes or creates an effect), serialized, and wrapped in
 *     `<!--[-->...<!--]-->` anchors when markers are on
 *   - everything else: escaped text
 *
 * @param child - The child value to serialize
 * @returns The child's HTML string
 *
 * @example
 * ```ts
 * serializeChild('a < b');              // 'a &lt; b' (escaped text)
 * serializeChild(ssr('<b>x</b>'));      // '<b>x</b>' (already markup)
 * serializeChild(['a', ssr('<i>b</i>')]); // 'a<i>b</i>' (concatenated)
 * serializeChild(null);                 // '' (skipped)
 * ```
 */
export function serializeChild(child: unknown): string
{
    if (child === null || child === undefined || child === false)
    {
        return '';
    }

    if (isSSRNode(child))
    {
        return child.html;
    }

    if (Array.isArray(child))
    {
        let out = '';
        for (const item of child)
        {
            out += serializeChild(item);
        }
        return out;
    }

    if (typeof child === 'function')
    {
        // Reactive hole: read the value WITHOUT subscribing (no live effect
        // on the server), then serialize it. The anchors let the client
        // hydrator find the exact node span this getter owns.
        const value = untrack(() => (child as () => unknown)());
        const inner = serializeChild(value);
        return markersOn ? `<!--[-->${ inner }<!--]-->` : inner;
    }

    return escapeText(String(child));
}

/**
 * Wraps a control-flow component's inner HTML in the invisible
 * `display:contents` span the DOM path also uses, tagging it with
 * `data-azeroth-co` (when markers are on) so the client hydrator can find
 * and adopt the wrapper.
 *
 * @param coType - The control-flow kind ('show', 'for', 'switch', ...)
 * @param inner - The already-serialized inner HTML
 * @returns The wrapper as an {@link SSRNode}
 *
 * @example
 * ```ts
 * // With markers off (renderToStaticMarkup):
 * wrapContents('show', '<p>hi</p>').html;
 * // '<span style="display:contents"><p>hi</p></span>'
 * ```
 */
export function wrapContents(coType: string, inner: string): SSRNode
{
    const marker = markersOn ? ` data-azeroth-co="${ escapeAttr(coType) }"` : '';
    return ssr(`<span style="display:contents"${ marker }>${ inner }</span>`);
}
