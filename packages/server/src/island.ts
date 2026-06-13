// island() marks a component as an interactivity boundary in an otherwise
// static server-rendered page. The page shell ships as plain HTML and is
// never hydrated; each island's markup is wrapped in an anchor carrying its
// module specifier and JSON props, and the client bootstrap
// (hydrateIslands, @azerothjs/renderer) revives exactly those subtrees.
//
// Props cross the network as JSON - that is the boundary contract, enforced
// here with a real error rather than silent stringify dropping. Pass ids
// and data, not signals or callbacks; the island creates its own state from
// them (the same way a route loader hands data to a page).
//
// Render modes:
//   string  - wrapper + inline markup (the SSR output).
//   dom     - transparent: the component renders inline. The same page
//             component works in a pure-CSR dev run.
//   hydrate - an error: islands exist so the page shell is NOT hydrated.
//             Reviving islands is hydrateIslands()'s job, and islands do
//             not nest.

import { isStringMode, isHydrating, serializeChild, escapeAttr, ssr } from '@azerothjs/reactivity';

/**
 * Wraps a component as an island. On the server, emits the island anchor
 * with serialized props around the component's markup; in a client (CSR)
 * run it renders the component inline.
 *
 * @typeParam P - The island's props - JSON-serializable by contract
 *
 * @param src - The module specifier the CLIENT registry resolves - the key
 *              you hand to hydrateIslands(), e.g. '/islands/counter.azeroth'
 * @param component - The island component (its module's default export)
 * @param props - JSON-serializable props, embedded in the markup
 *
 * @example
 * ```ts
 * // Server page shell - everything except the island ships static:
 * const Page = (): HTMLElement =>
 *     h('main', {},
 *         h('h1', {}, 'Mostly static page'),
 *         island('/islands/counter', Counter, { start: 5 }),
 *         h('footer', {}, 'static footer'));
 *
 * const html = renderToDocument(() => Page(), { title: 'Islands' });
 * ```
 */
export function island<P extends Record<string, unknown>>(
    src: string,
    component: (props: P) => HTMLElement,
    props: P
): HTMLElement
{
    if (isStringMode())
    {
        const json = serializeProps(src, props);
        const inner = serializeChild(component(props));
        return ssr(
            `<span style="display:contents" data-azeroth-island="${ escapeAttr(src) }"` +
            ` data-azeroth-props="${ escapeAttr(json) }">${ inner }</span>`
        ) as unknown as HTMLElement;
    }

    if (isHydrating())
    {
        throw new Error(
            `island("${ src }") reached hydrate(): islands exist so the page shell is NOT hydrated. ` +
            'Revive islands with hydrateIslands() from @azerothjs/renderer; islands do not nest.'
        );
    }

    // Pure client render (dev/CSR): the island boundary is transparent.
    return component(props);
}

/**
 * Stringifies island props, rejecting anything JSON cannot carry - a
 * signal getter or callback passed across the boundary would otherwise be
 * dropped silently and surface as `undefined` on the client.
 *
 * @internal
 */
function serializeProps(src: string, props: Record<string, unknown>): string
{
    return JSON.stringify(props, (key, value) =>
    {
        const kind = typeof value;
        if (kind === 'function' || kind === 'symbol' || kind === 'bigint' || (kind === 'undefined' && key !== ''))
        {
            throw new Error(
                `island("${ src }"): prop "${ key }" is a ${ kind } and cannot cross the island boundary - ` +
                'island props travel as JSON. Pass plain data; the island creates its own signals from it.'
            );
        }
        return value as unknown;
    });
}
