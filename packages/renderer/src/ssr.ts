/**
 * MODULE: renderer/ssr (internal)
 *
 * The element-specific half of server-side rendering: turning an h() call into an HTML string.
 * It mirrors, branch for branch, what applyProps/setProperty/appendChild do in h.ts's DOM path,
 * so the markup the server produces is structurally identical to what the browser would build -
 * which is what lets hydration adopt it node-for-node. The generic DOM-free pieces (escaping,
 * child serialization, the SSRNode wrapper) live in @azerothjs/reactivity's ssr; this file owns
 * the HTML-element specifics (tag names, void elements, attribute-vs-property rules). These
 * serializers are package-internal (consumed by h.ts in string mode), not public API.
 */

import type { Props, Child } from './types.ts';
import { untrack, serializeChild, escapeText, escapeAttr, ssr } from '@azerothjs/reactivity';
import type { SSRNode } from '@azerothjs/reactivity';

/**
 * HTML void elements: they have no children and no closing tag. Rendered
 * as `<tag ...>` with no content.
 *
 * @example
 * ```ts
 * VOID_ELEMENTS.has('br');   // true  -> emitted as '<br>', no </br>
 * VOID_ELEMENTS.has('div');  // false -> emitted with a closing tag
 * ```
 *
 * @internal
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set
([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);

/**
 * Props that h()'s DOM path sets as content rather than attributes
 * (`el.innerHTML = x` / `el.textContent = x`). The serializer handles them
 * as element content in {@link serializeElement}, so they must NOT be
 * emitted as attributes.
 *
 * @internal
 */
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent']);

/**
 * Resolves a possibly-reactive prop value to a concrete value, reading getters
 * without subscribing (no live effect on the server). Resolves WHILE the value
 * is a function so a getter-returning-a-getter collapses to its concrete value
 * - the server counterpart of the renderer's resolveReactive(). This is what
 * makes `class={classList(...)}` / `style={styleMap(...)}` (which the compiler
 * emits as `() => (classList(...))`) serialize to the resolved string instead
 * of the inner function's source. The bound guards a pathological self-returning
 * getter.
 *
 * @internal
 */
function resolveValue(value: unknown): unknown
{
    let resolved = value;
    let depth = 0;
    while (typeof resolved === 'function' && depth < 16)
    {
        const getter = resolved as () => unknown;
        resolved = untrack(() => getter());
        depth++;
    }

    return resolved;
}

/**
 * Serializes a props object to an attribute string (each attribute prefixed
 * with a space), mirroring h()'s applyProps / setProperty rules:
 *
 *   - `ref` and `on*` handlers -> skipped (no meaning in static HTML)
 *   - `innerHTML` / `textContent` -> skipped here (emitted as content)
 *   - reactive values (functions) -> resolved once via {@link resolveValue}
 *   - `false` / `null` / `undefined` -> attribute omitted
 *   - `true` -> boolean attribute (`disabled=""`)
 *   - everything else -> `key="<escaped value>"`
 *
 * Note: `value` / `checked` / `selected` / `disabled` are DOM properties on
 * the client, but server-side their correct initial representation IS the
 * matching attribute, which these general rules already produce.
 *
 * @param props - The props passed to h()
 * @returns The serialized attribute string (may be empty)
 *
 * @example
 * ```ts
 * serializeAttrs({ id: 'box', disabled: true, hidden: false });
 * // ' id="box" disabled=""'  (false attribute omitted, leading space)
 *
 * serializeAttrs({ onClick: handler, ref: r }); // '' (handlers/refs skipped)
 * ```
 */
export function serializeAttrs(props: Props): string
{
    let out = '';

    for (const [key, rawValue] of Object.entries(props))
    {
        if (key === 'ref')
        {
            continue;
        }

        if (key.startsWith('on') && typeof rawValue === 'function')
        {
            continue;
        }

        if (CONTENT_PROPERTIES.has(key))
        {
            continue;
        }

        const value = resolveValue(rawValue);

        if (value === false || value === null || value === undefined)
        {
            continue;
        }

        if (value === true)
        {
            out += ` ${ key }=""`;
            continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort attribute coercion, mirroring the DOM path's setAttribute fallback
        out += ` ${ key }="${ escapeAttr(String(value)) }"`;
    }

    return out;
}

/**
 * Serializes an array of children to HTML by delegating each to
 * {@link serializeChild} (which handles primitives, arrays, reactive holes,
 * and nested SSRNodes).
 *
 * @param children - The children passed to h()
 * @returns The concatenated, escaped inner HTML
 *
 * @example
 * ```ts
 * serializeChildren(['Hi ', 'there']);          // 'Hi there'
 * serializeChildren([serializeElement('b', {}, ['!'])]); // '<b>!</b>'
 * ```
 */
export function serializeChildren(children: Child[]): string
{
    let out = '';

    for (const child of children)
    {
        out += serializeChild(child);
    }

    return out;
}

/**
 * Serializes a single element (the `'string'`-mode counterpart to creating a
 * real DOM node in h()).
 *
 * Content precedence matches the DOM path: `innerHTML` (raw, unescaped) wins,
 * else `textContent` (escaped), else the serialized children. Void elements
 * emit no content and no closing tag.
 *
 * @param tag - The element tag name
 * @param props - The props/attributes
 * @param children - The child nodes
 * @returns The serialized element as an {@link SSRNode}
 *
 * @example
 * ```ts
 * serializeElement('div', { class: 'card' }, ['Hi']).html;
 * // '<div class="card">Hi</div>'
 *
 * serializeElement('img', { src: 'a.png' }, []).html;
 * // '<img src="a.png">'  (void element, no closing tag)
 * ```
 */
export function serializeElement(tag: string, props: Props, children: Child[]): SSRNode
{
    const tagName = tag.toLowerCase();
    const attrs = serializeAttrs(props);

    if (VOID_ELEMENTS.has(tagName))
    {
        return ssr(`<${ tagName }${ attrs }>`);
    }

    let inner: string;

    if ('innerHTML' in props)
    {
        // Raw passthrough: same trust model as `el.innerHTML = x`.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- innerHTML is caller-trusted raw content; non-string input is caller error surfaced visibly
        inner = String(resolveValue(props.innerHTML) ?? '');
    }
    else if ('textContent' in props)
    {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- textContent coerces like the DOM property; non-string input is caller error surfaced visibly
        inner = escapeText(String(resolveValue(props.textContent) ?? ''));
    }
    else
    {
        inner = serializeChildren(children);
    }

    return ssr(`<${ tagName }${ attrs }>${ inner }</${ tagName }>`);
}
