/**
 * MODULE: reactivity/ssr
 *
 * The DOM-free half of server-side rendering: helpers that build HTML strings without
 * ever touching `document`, so they run on a bare server. Element-specific
 * serialization (tag names, void elements, attribute rules) lives in
 * @azerothjs/renderer; the pieces here are the ones @azerothjs/component also needs
 * (ErrorBoundary serializes its children; every control-flow component wraps its output
 * in anchored contents), which is why they sit in reactivity - the only package beneath
 * both renderer and component.
 *
 * SSRNode WRAPPER:
 * In string mode h() returns an SSRNode (cast to HTMLElement) instead of a real
 * element. It carries already-serialized, already-escaped HTML plus a `__ssr` brand, so
 * serializers can tell finished element markup apart from user text that still needs
 * escaping.
 *
 * HYDRATION MARKERS:
 * When on (renderToString), reactive holes are wrapped in paired comment anchors
 * `<!--[-->...<!--]-->` and control-flow wrappers in `<!--azc:type-->...<!--/azc-->`,
 * so the client hydrator can locate the exact nodes a getter owns. When off
 * (renderToStaticMarkup) the output is clean HTML with no framework bookkeeping.
 */

import { untrack } from './untrack.ts';

/**
 * A serialized node produced in 'string' render mode. `html` is fully serialized and
 * already HTML-escaped; the `__ssr` brand lets {@link isSSRNode} distinguish it from raw
 * user text.
 */
export interface SSRNode
{
    readonly __ssr: true;
    html: string;
}

/**
 * Type guard: whether `x` is an {@link SSRNode} (finished markup) rather than a
 * primitive child needing escaping.
 *
 * @param x - Any value.
 * @returns true if `x` is an SSRNode.
 */
export function isSSRNode(x: unknown): x is SSRNode
{
    return typeof x === 'object' && x !== null && (x as { __ssr?: unknown }).__ssr === true;
}

/**
 * Brands already-serialized, already-escaped HTML as an {@link SSRNode}.
 *
 * @param html - Finished, escaped HTML markup.
 * @returns The branded node.
 */
export function ssr(html: string): SSRNode
{
    return { __ssr: true, html };
}

/** Whether hydration markers are currently emitted; defaults OFF so stray serialization is clean. @internal */
let markersOn = false;

/**
 * Enables/disables hydration markers for subsequent serialization. renderToString turns
 * them on; renderToStaticMarkup leaves them off.
 *
 * @internal
 * @param on - Whether to emit hole/control-flow comment anchors.
 */
export function setSSRMarkers(on: boolean): void
{
    markersOn = on;
}

/**
 * Whether hydration markers are currently emitted.
 *
 * @internal
 * @returns true when markers are on.
 */
export function getSSRMarkers(): boolean
{
    return markersOn;
}

/**
 * Escapes a string for HTML TEXT content (`&`, `<`, `>`).
 *
 * @param value - Raw text.
 * @returns Text safe to place between tags.
 */
export function escapeText(value: string): string
{
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes a string for a double-quoted HTML ATTRIBUTE value (`&`, `"`, `<`, `>`).
 *
 * @param value - Raw attribute value.
 * @returns Value safe inside "...".
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
 * serializeChild
 *
 * PURPOSE:
 * Serializes one child value to HTML, mirroring h()'s DOM-path child handling so SSR
 * output structurally matches what the client would build - which is what makes
 * hydration align node-for-node.
 *
 * WHY IT EXISTS:
 * SSR and the DOM renderer must agree on exactly which nodes exist and in what order, or
 * hydration mismatches. Centralizing child serialization here (shared by renderer,
 * server, and component) guarantees one definition of that mapping.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, SSR string mode. Consumes the same child shapes h() accepts and emits the
 * string form, including the reactive-hole anchors the hydrator looks for.
 *
 * INPUT CONTRACT:
 * - child: any h() child - null/undefined/false (skipped), SSRNode (its html), array
 *   (each item serialized), function (a reactive hole), or a primitive (escaped text).
 *
 * OUTPUT CONTRACT:
 * - The child's HTML string. Reactive holes are wrapped in `<!--[-->...<!--]-->` when
 *   markers are on, matching the single span the client hydrator adopts.
 *
 * WHY THIS DESIGN:
 * A reactive hole is read via untrack (no subscription/effect on the server) and
 * resolved WHILE it is a function, so a getter-returning-a-getter collapses to its
 * concrete value instead of serializing inner function source; resolving here (rather
 * than recursing) keeps exactly one anchor pair per hole, matching the DOM.
 *
 * EDGE CASES:
 * - The getter-chain unwrap is depth-capped (16) to avoid a pathological loop.
 * - false is skipped (like null/undefined) so `cond && <x/>` serializes nothing when false.
 *
 * PERFORMANCE NOTES:
 * Linear in the serialized output size; arrays concatenate, holes read once.
 *
 * @param child - The child value to serialize.
 * @returns The child's HTML string.
 * @see {@link wrapContentsAnchored}
 * @example
 * serializeChild('a < b');         // 'a &lt; b'
 * serializeChild(ssr('<b>x</b>')); // '<b>x</b>'
 * serializeChild(null);            // ''
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
        // Reactive hole: read the value WITHOUT subscribing (no live effect on the
        // server). Resolve WHILE it is a function so a getter-returning-a-getter (e.g. a
        // `{ p.title }` hole emitted as `() => (p.title)`, where p.title is `() =>
        // string`) collapses to its concrete value rather than serializing inner source.
        // Resolving here (not recursing) keeps a SINGLE `<!--[-->...<!--]-->` pair,
        // matching the one span the client hydrator adopts.
        let value = untrack(() => (child as () => unknown)());
        let depth = 0;
        while (typeof value === 'function' && depth < 16)
        {
            const getter = value as () => unknown;
            value = untrack(() => getter());
            depth++;
        }
        const inner = serializeChild(value);
        return markersOn ? `<!--[-->${ inner }<!--]-->` : inner;
    }

    return escapeText(String(child));
}

/**
 * wrapContentsAnchored
 *
 * PURPOSE:
 * Wraps a control-flow component's inner HTML in comment-node anchors (not a wrapper
 * element), producing the start/end markers the client adopts and reuses for later swaps.
 *
 * WHY IT EXISTS:
 * Control-flow output must be locatable on the client AND legal in every HTML context.
 * Comments are valid inside `<table>`/`<tbody>`, `<select>`, and `<ul>`, where the parser
 * would hoist a stray `<span>` out of the table; an element wrapper would corrupt the
 * tree. Comment anchors avoid that while still marking the live range.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, SSR string mode. Emitted by control-flow components (Show/For/Switch/...) so
 * the hydrator can find and re-drive their ranges.
 *
 * INPUT CONTRACT:
 * - coType: the control-flow kind ('show', 'for', 'switch', ...).
 * - inner: the already-serialized inner HTML.
 *
 * OUTPUT CONTRACT:
 * - Markers off: just `inner` (no anchors - nothing to hydrate).
 * - Markers on: `<!--azc:coType-->inner<!--/azc-->`, returned as an {@link SSRNode}.
 *
 * WHY THIS DESIGN:
 * The open anchor carries the kind (for debugging); the close is a bare `/azc`. The
 * `azc` sigil is distinct from reactive-hole anchors (`[`/`]`) so the two never collide,
 * and the hydrator matches them by BALANCED depth so nested control-flow adopts correctly.
 *
 * EDGE CASES:
 * - With markers off the result is an SSRNode wrapping `inner` verbatim (static markup).
 *
 * PERFORMANCE NOTES:
 * O(1) string wrap around already-serialized content.
 *
 * @param coType - The control-flow kind.
 * @param inner - The already-serialized inner HTML.
 * @returns The anchored content as an {@link SSRNode}.
 * @see {@link serializeChild}
 * @example
 * wrapContentsAnchored('for', '<li>a</li>').html; // '<!--azc:for--><li>a</li><!--/azc-->' (markers on)
 */
export function wrapContentsAnchored(coType: string, inner: string): SSRNode
{
    if (!markersOn)
    {
        return ssr(inner);
    }

    return ssr(`<!--azc:${ coType }-->${ inner }<!--/azc-->`);
}
