/**
 * MODULE: server/island
 *
 * island() marks a component as an interactivity boundary in an otherwise static
 * server-rendered page. The page shell ships as plain HTML and is never hydrated; each island's
 * markup is wrapped in an anchor carrying its module specifier and JSON props, and the client
 * bootstrap (hydrateIslands from @azerothjs/renderer) revives exactly those subtrees.
 *
 * Props cross the network as JSON - that is the boundary contract, enforced here with a real
 * error rather than a silent stringify drop. Pass ids and data, not signals or callbacks; the
 * island creates its own state from them (like a route loader handing data to a page).
 *
 * RENDER MODES: string = anchor + inline markup (SSR output); dom = transparent (renders inline,
 * so the same page component works in a pure-CSR dev run); hydrate = an error (islands exist so
 * the page shell is NOT hydrated; reviving them is hydrateIslands()'s job, and islands do not nest).
 */

import { isStringMode, isHydrating, serializeChild, escapeAttr, ssr } from '@azerothjs/reactivity';

/**
 * island
 *
 * PURPOSE:
 * Wraps a component as an island: on the server it emits the island anchor (carrying the module
 * specifier and serialized props) around the component's markup; in a client/CSR run it renders
 * the component inline (transparent).
 *
 * WHY IT EXISTS:
 * Islands architecture ships a mostly-static page and hydrates only interactive regions, so client
 * JS and hydration cost scale with the islands, not the whole page. island() is how the SERVER
 * marks those boundaries - emitting the anchor + props that hydrateIslands() later matches and
 * revives - while keeping the shell pure HTML.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, server; the SSR half of islands (its client half is hydrateIslands in
 * @azerothjs/renderer). Mode-dispatched: 'string' emits the anchor wrapper; 'dom' is transparent
 * (inline render); 'hydrate' throws, because the shell is not hydrated.
 *
 * INPUT CONTRACT:
 * - src: the module specifier the CLIENT registry resolves (the key handed to hydrateIslands),
 *   e.g. '/islands/counter.azeroth'.
 * - component: the island component (its module's default export).
 * - props: JSON-serializable props, embedded in the markup; a non-JSON value throws.
 *
 * OUTPUT CONTRACT:
 * - string mode: an SSRNode wrapping the anchor + serialized markup. dom mode: the component
 *   rendered inline. hydrate mode: throws with guidance to use hydrateIslands().
 *
 * WHY THIS DESIGN:
 * Props travel as JSON because they cross the server->client boundary in a data attribute; the
 * serializer throws on functions/symbols/bigints so a signal or callback is not silently dropped
 * (surfacing as undefined on the client). The dom-mode transparency lets ONE page component serve
 * both SSR and pure-CSR dev without change.
 *
 * WHEN TO USE:
 * For server pages that are mostly static with a few interactive widgets (counter, search box,
 * cart) you want revived independently.
 *
 * WHEN NOT TO USE:
 * For a fully interactive app (render the whole tree and hydrate it). Do not nest islands.
 *
 * EDGE CASES:
 * - A prop that JSON cannot carry (function/symbol/bigint/undefined) throws a descriptive error.
 * - Reaching it in hydrate mode throws (the shell is not hydrated; use hydrateIslands()).
 *
 * PERFORMANCE NOTES:
 * One anchor wrapper + inline serialization per island; client revival cost scales with the
 * number/size of islands, not the page.
 *
 * DEVELOPER WARNING:
 * `src` MUST match the key in the client's hydrateIslands registry, or the island stays static.
 * Props must be plain JSON data (ids/values), not signals/handlers - the island builds its own
 * state from them.
 *
 * @typeParam P - The island's props (JSON-serializable by contract).
 * @param src - The client-registry module specifier.
 * @param component - The island component.
 * @param props - JSON-serializable props embedded in the markup.
 * @returns An island-anchor SSRNode (string mode) or the inline component (dom mode).
 * @see hydrateIslands (in @azerothjs/renderer)
 * @example
 * const Page = () => h('main', {},
 *   h('h1', {}, 'Mostly static'),
 *   island('/islands/counter', Counter, { start: 5 })
 * );
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
