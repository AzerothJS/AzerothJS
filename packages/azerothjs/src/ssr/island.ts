/**
 * Marks a component as an interactivity boundary in an otherwise static
 * server-rendered page. The page shell ships as plain HTML and is never hydrated; each island's
 * ROOT ELEMENT carries the anchor attributes (module specifier + JSON props) - no wrapper node,
 * so an island is valid anywhere its own root is (a `<tr>` island sits directly in a `<tbody>`) -
 * and the client bootstrap (hydrateIslands from azerothjs) revives exactly those subtrees.
 *
 * Props cross the network as JSON - that is the boundary contract, enforced here with a real
 * error rather than a silent stringify drop. Pass ids and data, not signals or callbacks; the
 * island creates its own state from them (like a route loader handing data to a page).
 *
 * RENDER MODES: string = anchor + inline markup (SSR output); dom = transparent (renders inline,
 * so the same page component works in a pure-CSR dev run); hydrate = an error (islands exist so
 * the page shell is NOT hydrated; reviving them is hydrateIslands()'s job, and islands do not nest).
 */

import { isStringMode, isHydrating, escapeAttr, ssr } from '../reactivity/index.ts';
import { serializeChild } from '../reactivity/internal.ts';

/**
 * Marks a component as an interactivity boundary in an otherwise static page.
 *
 * `src` MUST match the key in the client's hydrateIslands registry, or the island simply
 * stays static - there is no error for a mismatch on this side.
 *
 * Props cross the boundary as JSON in a data attribute, so pass ids and values and let the
 * island build its own state from them. A function, symbol or bigint throws a descriptive
 * error rather than being silently dropped and surfacing as `undefined` on the client.
 *
 * In a pure client run it renders inline and is completely transparent, so one page component
 * serves both SSR and a CSR dev run unchanged. Reaching it while hydrating throws: the shell
 * is deliberately not hydrated, and reviving islands is hydrateIslands's job. Islands do not
 * nest.
 *
 * @typeParam P - The props, JSON-serializable by contract.
 * @param src - The module specifier the client registry resolves.
 * @param component - The island component, its module's default export.
 * @param props - Embedded in the markup as JSON.
 * @returns The component's markup with the anchor attributes on its ROOT element, so an
 *          island is valid anywhere its own root is - a `<tr>` island sits directly in a
 *          `<tbody>`.
 * @throws {Error} If a prop cannot be represented as JSON, or if called while hydrating.
 * @example
 * const Page = () => h('main', {},
 *     h('h1', {}, 'Mostly static'),
 *     island('/islands/counter', Counter, { start: 5 })
 * );
 *
 * const html = renderToDocument(() => Page(), { title: 'Islands' });
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

        // The anchor attributes ride on the island's OWN root element - no wrapper node
        // of any kind. A wrapper (even `display:contents`) is invalid inside
        // `<table>`/`<tbody>`/`<select>` and defeats direct-child selectors, the same
        // doctrine the co-range model enforces everywhere else; here the component's
        // single-element root IS the boundary, so the island of a `<tr>` is a valid row.
        const rootTag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
        if (rootTag === null)
        {
            throw new Error(
                `island("${ src }"): the component must render a single ELEMENT root - its serialized ` +
                'output starts with something else. Wrap the island content in one host element.'
            );
        }
        const attrs = ` data-azeroth-island="${ escapeAttr(src) }" data-azeroth-props="${ escapeAttr(json) }"`;
        return ssr(
            `${ inner.slice(0, rootTag[0].length) }${ attrs }${ inner.slice(rootTag[0].length) }`
        ) as unknown as HTMLElement;
    }

    if (isHydrating())
    {
        throw new Error(
            `island("${ src }") reached hydrate(): islands exist so the page shell is NOT hydrated. ` +
            'Revive islands with hydrateIslands() from azerothjs; islands do not nest.'
        );
    }

    // Pure client render (dev/CSR): the island boundary is transparent.
    return component(props);
}

/**
 * Stringifies island props, rejecting anything JSON cannot carry - a signal getter or callback
 * passed across the boundary would otherwise be dropped silently and surface as undefined on the
 * client.
 *
 * @internal
 * @param src - The island src (for the error message).
 * @param props - The props to serialize.
 * @returns The JSON string.
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
