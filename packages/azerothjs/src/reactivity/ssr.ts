/**
 * The DOM-free half of server-side rendering: helpers that build HTML strings without ever
 * touching `document`, so they run on a bare server. Element-specific serialization - tag
 * names, void elements, attribute rules - lives in the renderer; what sits here is what the
 * component layer needs too, which is why it lives beneath both.
 *
 * In string mode h() returns an {@link SSRNode} rather than a real element. It carries
 * already-serialized, already-escaped HTML plus a brand, so a serializer can tell finished
 * markup from user text that still needs escaping.
 *
 * With markers on, reactive holes are wrapped in paired comment anchors
 * `<!--[-->...<!--]-->` and control-flow output in `<!--azc:type-->...<!--/azc-->`, so the
 * client hydrator can locate the exact nodes a getter owns. With markers off the output is
 * clean HTML carrying no framework bookkeeping.
 */

import { untrack } from './untrack.ts';
import { resolveThunks } from './resolve-thunks.ts';
import { ssrMarkersActive } from './render-mode.ts';

/** Cycle bound for the child graph; see serializeChild. */
const MAX_CHILD_DEPTH = 512;

/**
 * A serialized node produced in string render mode. `html` is finished and already
 * escaped; the brand is what lets {@link isSSRNode} tell it from raw user text.
 */
export interface SSRNode
{
    readonly __ssr: true;
    html: string;
}

/** Whether `x` is finished markup rather than a primitive child that still needs escaping. */
export function isSSRNode(x: unknown): x is SSRNode
{
    return typeof x === 'object' && x !== null && (x as { __ssr?: unknown }).__ssr === true;
}

/**
 * Brands a string as finished markup, exempting it from escaping downstream.
 *
 * @param html - Must already be serialized AND escaped. Passing unescaped user input here
 *               is an injection.
 */
export function ssr(html: string): SSRNode
{
    return { __ssr: true, html };
}

/**
 * Escapes `&`, `<` and `>` for HTML text content between tags.
 *
 * Not sufficient for an attribute value, which also needs the quote escaped: use
 * {@link escapeAttr} there.
 */
export function escapeText(value: string): string
{
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Escapes `&`, `"`, `<` and `>` for a DOUBLE-QUOTED attribute value. Single-quoted or
 * unquoted attributes are not covered, and neither is a URL context, where a
 * `javascript:` scheme survives escaping intact.
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
 * Serializes one child value to HTML, mirroring the DOM path's child handling exactly. The
 * two must agree on which nodes exist and in what order, or hydration mismatches, which is
 * why this mapping is defined once and shared.
 *
 * `null`, `undefined` and `false` all serialize to nothing, so `cond && <x/>` emits nothing
 * when false. An SSRNode contributes its markup, an array serializes item by item, a
 * function is a reactive hole, and anything else is escaped text.
 *
 * A hole is read through untrack - there are no subscriptions on the server - and resolved
 * while it is a function, so a getter returning a getter collapses to its concrete value
 * instead of serializing function source. Resolving here rather than recursing is what
 * keeps exactly one anchor pair per hole, matching the single span the hydrator adopts.
 *
 * @param child - Any value h() accepts as a child.
 * @param depth - Recursion depth, bounded to stop a self-referencing child array.
 * @returns The child's HTML.
 * @example
 * serializeChild('a < b');         // 'a &lt; b'
 * serializeChild(ssr('<b>x</b>')); // '<b>x</b>'
 * serializeChild(null);            // ''
 *
 * @see {@link wrapContentsAnchored}
 */
export function serializeChild(child: unknown, depth = 0): string
{
    if (child === null || child === undefined || child === false)
    {
        return '';
    }

    if (isSSRNode(child))
    {
        return child.html;
    }

    // Bounds the child GRAPH the array branch walks: an array containing itself is a cycle
    // nothing else here would stop. Element nesting does not pay for this, since a nested
    // element is an SSRNode returned above. 512 is far past real nesting and far below the stack.
    if (depth >= MAX_CHILD_DEPTH)
    {
        return '';
    }

    if (Array.isArray(child))
    {
        let out = '';
        for (const item of child)
        {
            out += serializeChild(item, depth + 1);
        }
        return out;
    }

    if (typeof child === 'function')
    {
        const value = untrack(() => resolveThunks(child));
        // resolveThunks returns the value STILL AS A FUNCTION when its own depth bound is hit,
        // which means a getter that returns a getter forever. Recursing on that lands straight
        // back in this branch and resolves to a function again, so the bound would guard
        // nothing. There is no value to serialize, and function source must never reach the
        // document.
        const inner = typeof value === 'function' ? '' : serializeChild(value, depth + 1);
        return ssrMarkersActive() ? `<!--[-->${ inner }<!--]-->` : inner;
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort fallback: primitives stringify correctly, and a plain object landing here is caller error surfaced as visible "[object Object]" rather than a throw mid-render
    return escapeText(String(child));
}

/**
 * Wraps a control-flow component's inner HTML in comment anchors, producing the start and
 * end markers the client adopts and reuses for later swaps.
 *
 * Comments rather than a wrapper element because the range must be legal in every HTML
 * context: inside `<table>`, `<select>` or `<ul>` the parser would hoist a stray `<span>`
 * out of the table and corrupt the tree, while a comment is valid anywhere.
 *
 * The open anchor carries the kind for debuggability and the close is a bare `/azc`. That
 * sigil is distinct from the reactive-hole anchors, so the two schemes never collide, and
 * the hydrator matches them by balanced depth so nested control flow adopts correctly.
 *
 * With markers off the content is returned verbatim, since there is nothing to hydrate.
 *
 * @param coType - The control-flow kind, such as `'show'` or `'for'`.
 * @param inner - Already-serialized inner HTML.
 * @example
 * wrapContentsAnchored('for', '<li>a</li>').html;
 * // markers on:  '<!--azc:for--><li>a</li><!--/azc-->'
 * // markers off: '<li>a</li>'
 *
 * @see {@link serializeChild}
 */
export function wrapContentsAnchored(coType: string, inner: string): SSRNode
{
    if (!ssrMarkersActive())
    {
        return ssr(inner);
    }

    return ssr(`<!--azc:${ coType }-->${ inner }<!--/azc-->`);
}
