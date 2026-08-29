/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The element-specific half of server-side rendering: an h() call as an HTML string.
 *
 * It mirrors the DOM path branch for branch, so the markup the server produces is
 * structurally identical to what the browser would build - which is exactly what lets
 * hydration adopt it node for node. The DOM-free pieces (escaping, child serialization, the
 * SSRNode wrapper) live in the reactivity layer; what belongs here is the HTML-element
 * specifics: tag names, void elements, and the attribute-versus-property rules.
 *
 * This module also owns the render-safety gate, assertSafeTag and assertSafeAttribute, which
 * BOTH render modes call. A tag or value one mode refuses can therefore never be written by
 * the other. The only public symbols here are the two escape hatches that opt a single value
 * out of that gate.
 */

import type { Props, Child } from './types.ts';
import { untrack, escapeText, escapeAttr, ssr } from '../reactivity/index.ts';
import { resolveThunks, serializeChild, currentStreamSession } from '../reactivity/internal.ts';
import type { SSRNode } from '../reactivity/index.ts';
import {
    isChildResolvedProperty,
    hostEventType,
    isReservedHostAttribute,
    isEventNamespace,
    refValueMessage,
    reservedHostAttributeMessage,
    handlerValueMessage,
    canonicalHandlerName,
    CONTENT_PROPERTIES,
    VOID_ELEMENTS,
    RAW_TEXT_ELEMENTS,
    isAriaStateAttribute,
    URL_ATTRIBUTES,
    REFUSED_TAGS,
    rendersAsImage,
    isExecutableUrl,
    scriptTypeExecutes,
    executableUrlMessage,
    srcdocMessage,
    refusedTagMessage,
    executableScriptMessage
} from '../semantics.ts';

/**
 * Raw-text content is CDATA, but CDATA is closed by the element's own end tag: a child
 * containing `</script>` terminates the element mid-content and everything after it is
 * parsed as MARKUP - `h('script', {}, JSON.stringify(data))` becomes an injection the
 * moment `data` holds `'</script><img onerror=...>'`. The DOM path appends an inert Text
 * node for the same call, so without this transform the same component is safe
 * client-rendered and live server-rendered.
 *
 * The `<` opening a sequence the HTML tokenizer acts on inside script data (`</script`,
 * `<script`, `<!--`) becomes the six-character JS unicode escape for `<`; inside style
 * data, the `<` opening `</style` becomes the CSS hex escape `\3c`. Both decode back to
 * `<` in every context
 * that can legitimately carry the sequence (JSON/JS strings, template literals, regexes,
 * CSS strings), so real content round-trips losslessly - only in raw code position do
 * they differ, where the original sequence already terminated the element.
 *
 * @internal
 */
const SCRIPT_BREAKOUT = /<(?=\/script|script|!--)/gi;

/** The `<` opening a `</style` sequence, which would close a style element mid-content. */
export const STYLE_BREAKOUT: RegExp = /<(?=\/style)/gi;

/** Applies the raw-text breakout transform for one element. @internal */
function neutralizeRawText(tagName: string, content: string): string
{
    return tagName === 'script'
        ? content.replace(SCRIPT_BREAKOUT, '\\u003c')
        : content.replace(STYLE_BREAKOUT, '\\3c');
}

/**
 * Characters an HTML attribute name may not contain (the HTML5 attribute-name
 * production): controls, space, quote, apostrophe, `>`, `/`, and `=`. A name
 * carrying any of these cannot be written as an attribute without breaking out
 * of the attribute context - which is exactly the injection an attacker attempts
 * by controlling a prop KEY (`h('div', { 'x" onmouseover="alert(1)': 'v' })`).
 * The DOM path's `setAttribute` throws `InvalidCharacterError` on such a name; the
 * serializer must reject it too rather than emit it raw.
 *
 * @internal
 */
// `<` and a backtick are in the set for the same reason as the rest: the name is written straight
// into the tag. Neither is exploitable alone - a spec tokenizer keeps `a<b` as one attribute name
// - but a serializer interpolating attacker text should not be the thing deciding which
// delimiters happen not to matter today.
// eslint-disable-next-line no-control-regex -- matching control characters is the POINT: a control char in an attribute name is invalid HTML and an injection vector
const INVALID_ATTR_NAME = /[\u0000-\u0020\u007F-\u009F"'`<>/=]/;

/** The two things an author can take responsibility for: a URL's scheme, or a tag name. @internal */
type UnsafeKind = 'url' | 'tag';

/**
 * The opt-out marker {@link unsafeUrl} / {@link unsafeTag} return. It is an OBJECT, not a
 * string, so the gate's permission can never be forged by data: no JSON payload, form field or
 * database column deserializes into one - only a literal call in the author's own source does.
 * It stringifies to the original value, so every writer downstream (escapeAttr, setAttribute,
 * createElement) sees exactly the string that was passed in.
 *
 * @internal
 */
class UnsafeValue
{
    readonly #value: string;
    readonly #kind: UnsafeKind;

    constructor(value: string, kind: UnsafeKind)
    {
        this.#value = value;
        this.#kind = kind;
    }

    public get kind(): UnsafeKind
    {
        return this.#kind;
    }

    public toString(): string
    {
        return this.#value;
    }
}

/**
 * The string behind an {@link UnsafeValue} of `kind`, or null when `value` is not one. The kind
 * is part of the match so a URL the author vetted cannot also authorize a tag, or the reverse.
 *
 * @internal
 */
function unbrand(value: unknown, kind: UnsafeKind): string | null
{
    return value instanceof UnsafeValue && value.kind === kind ? value.toString() : null;
}

/**
 * Marks one URL as author-vetted, so the render-safety gate writes it verbatim into a URL
 * attribute - `href`, `src`, `action`, `formaction`, `poster`, `xlink:href`, `data` - even
 * when its scheme is one the framework otherwise refuses, and into `srcdoc`, which is
 * refused outright.
 *
 * The gate blocks `javascript:`, `vbscript:` and non-image `data:` URLs because a value
 * reaching them is almost always user data that was never meant to be code. Almost always is
 * not always: a bookmarklet builder, a generated SVG document, a legacy `javascript:void(0)`
 * anchor are all real. Those get an explicit, greppable opt-in at the one call site that
 * needs it, rather than a global switch that disarms the gate everywhere.
 *
 * Use it when the URL is a literal in your own source, or one you built from values you
 * validated. NEVER use it on anything that came from a request, a database, a file or a
 * user: there is no vetting left in the call, so it simply reinstates the vulnerability the
 * gate exists to stop.
 *
 * @param value - Written verbatim, with no further checking.
 * @returns An opaque marker that stringifies to `value`, typed as `string` so it drops into a
 *          prop unchanged.
 * @example
 * h('a', { href: unsafeUrl('javascript:void(0)') }, 'legacy anchor');
 * h('img', { src: unsafeUrl(`data:image/svg+xml,${ encodeURIComponent(chart) }`) });
 *
 * @see {@link unsafeTag}
 */
export function unsafeUrl(value: string): string
{
    return new UnsafeValue(value, 'url') as unknown as string;
}

/**
 * Marks one tag name as author-vetted, so h() creates it even when the render-safety gate
 * refuses it: an executing `<script>`, or `<base>`, `<object>` and `<embed>`.
 *
 * Those four are how injected markup gets from content to code, so they are refused by
 * default and an app that genuinely needs one - a third-party loader, an analytics snippet -
 * names itself at the call site. A NON-executing script, `type="application/ld+json"` or any
 * other data block, needs no opt-in at all.
 *
 * Use it with a literal tag name for content you control. NEVER use it with a tag name that
 * came from data: a `<script>` whose content is also data is remote code execution in the
 * visitor's session, however the tag name was spelled.
 *
 * @param name - Created with no further checking.
 * @returns An opaque marker that stringifies to `name`, typed as `string` so it drops into
 *          h() unchanged.
 * @example
 * h(unsafeTag('script'), { src: 'https://cdn.example.com/widget.js', async: true });
 *
 * @see {@link unsafeUrl}
 */
export function unsafeTag(name: string): string
{
    return new UnsafeValue(name, 'tag') as unknown as string;
}

/**
 * Rejects a prop that cannot be written as an HTML attribute without becoming an
 * injection, with ONE policy shared by the serializer and the DOM path (h.ts):
 *
 *   - a NAME containing whitespace, quotes, `>`, `/`, or `=` breaks out of the
 *     attribute context (`setAttribute` throws InvalidCharacterError for the same input);
 *   - an `on*` prop whose VALUE is not a function would be written as a LIVE inline
 *     event handler (`onerror="fetch(...)"` executes) - the classic string-handler XSS.
 *     null/undefined/false pass so a conditional handler can be omitted;
 *   - a URL attribute whose VALUE carries an executable scheme, and `srcdoc`
 *     (see {@link assertSafeUrl}).
 *
 * Emitting any of them raw is the XSS. Fail loud, identically on server and client.
 *
 * @internal
 */
export function assertSafeAttribute(key: string, value: unknown, tag?: string): void
{
    if (key === '' || INVALID_ATTR_NAME.test(key))
    {
        throw new Error(`azeroth: invalid attribute name ${ JSON.stringify(key) } - names may not contain whitespace, quotes, '>', '/', or '='.`);
    }

    // Defense in depth: the prop dispatchers route the whole on* namespace to the event
    // machinery (handler-form) or refuse it (reserved) before any attribute write, so a
    // name landing here is an internal invariant break - and writing it would create a
    // live inline handler, the classic string-handler XSS. Case-insensitive because HTML
    // attribute names are.
    if (isEventNamespace(key))
    {
        throw new Error(`azeroth: ${ JSON.stringify(key) } is in the on* event namespace and is never written as an attribute.`);
    }

    assertSafeUrl(key, value, tag);
}

/**
 * Rejects a URL-bearing attribute whose value the browser would run instead of fetch, and
 * `srcdoc` in every form - an inline document, not a URL, and the one attribute whose value IS
 * markup. The value is normalized before its scheme is read (see {@link URL_CONTROL_CHARS}).
 * {@link unsafeUrl} opts a single value out.
 *
 * @internal
 */
function assertSafeUrl(key: string, value: unknown, tag?: string): void
{
    if (value === false || value === null || value === undefined || unbrand(value, 'url') !== null)
    {
        return;
    }

    const name = key.toLowerCase();
    // A tag marker is not a url marker: an opt-in authorizes exactly the one thing it names, so
    // the wrong brand is judged as the string it would be written as.
    const candidate: unknown = unbrand(value, 'tag') ?? value;

    if (name === 'srcdoc')
    {
        throw new Error(`azeroth: ${ srcdocMessage(key) }`);
    }

    // Judged on the COERCED value, because that is what both writers put in the document:
    // serializeAttrs and setProperty each end in String(value). Testing `typeof === 'string'`
    // let every other carrier of the same text through - an array most realistically, since a
    // repeated query parameter yields one from every mainstream parser.
    if (URL_ATTRIBUTES.has(name))
    {
        const written = asWritten(candidate);
        if (written !== null && isExecutableUrl(written, rendersAsImage(tag, name)))
        {
            throw new Error(`azeroth: ${ executableUrlMessage(key, written) }`);
        }
    }
}

/**
 * The text a value becomes in the document, or null when it has no string form. An
 * unconvertible value (a null-prototype object, a Symbol under template coercion) is left to
 * the writer, which throws on it for its own reasons - the gate must not turn that into a
 * different error.
 *
 * @internal
 */
/**
 * Whether this attribute is an ARIA boolean, which does NOT follow the HTML boolean-attribute
 * convention.
 *
 * For a real boolean attribute, presence IS the value: `disabled=""` is disabled and an absent
 * `disabled` is not. ARIA is the opposite - the value is a STRING, and the three states are
 * distinct: `aria-expanded="true"` (open), `aria-expanded="false"` (a collapsed control, which
 * assistive technology announces as collapsed), and absent (not expandable at all). Writing
 * `false` as "remove the attribute" silently downgrades the second to the third, and writing
 * `true` as `aria-expanded=""` is not a valid ARIA value at all.
 *
 * Shared by both writers so the DOM and SSR paths cannot drift apart on it. String values
 * (`aria-checked="mixed"`) pass through untouched.
 *
 * @internal
 * @param key - The attribute name.
 * @param value - The value about to be written.
 * @returns true when the value must be written as the literal "true"/"false".
 */
export function isAriaBoolean(key: string, value: unknown): boolean
{
    return typeof value === 'boolean' && isAriaStateAttribute(key);
}

function asWritten(value: unknown): string | null
{
    if (value === true)
    {
        return null; // a boolean attribute is written as "", never as a URL
    }
    try
    {
        return String(value);
    }
    catch
    {
        return null;
    }
}

/**
 * Validates the tag h() was handed, in every render mode, and returns the concrete tag name to
 * build with (unwrapping an {@link unsafeTag} marker). The refused set is the markup that turns
 * content into execution - see {@link REFUSED_TAGS} for why `<iframe>` is not in it, and
 * {@link scriptTypeExecutes} for why a data-block `<script>` is allowed.
 *
 * The original casing is returned, not the lowercased name: `foreignObject` and the other
 * camelCase SVG tags must reach createElementNS spelled exactly as given.
 *
 * @internal
 */
export function assertSafeTag(tag: string, props: Props): string
{
    const vetted = unbrand(tag, 'tag');
    if (vetted !== null)
    {
        // The name production is checked even here. unsafeTag() authorizes a refused TAG
        // (`script`, `base`); it was never meant to authorize arbitrary markup, and the string
        // is interpolated straight into `<...>` by serializeElement. Every legal tag passes,
        // so the opt-out loses nothing it was for.
        return assertTagName(vetted);
    }

    // A url marker is not a tag marker (see assertSafeUrl for the mirror case).
    const raw = assertTagName(unbrand(tag, 'url') ?? tag);
    const name = raw.toLowerCase();

    if (REFUSED_TAGS.has(name))
    {
        throw new Error(`azeroth: ${ refusedTagMessage(name) }`);
    }

    if (name === 'script' && scriptExecutes(props))
    {
        throw new Error(`azeroth: ${ executableScriptMessage() }`);
    }

    return raw;
}

/**
 * A legal HTML/SVG tag name: a letter, then letters, digits, `-`, `_`, `.` or `:`. Covers
 * custom elements (`my-widget`) and the camelCase SVG names (`foreignObject`, `clipPath`),
 * and admits nothing that can carry an attribute, close a tag, or open one.
 *
 * @internal
 */
const TAG_NAME = /^[A-Za-z][A-Za-z0-9._:-]*$/;

/**
 * Rejects a tag name the serializer would write into `<...>` as something other than a name.
 * The refused-name set alone is not enough: a name is not markup, and `img src=x onerror=...`
 * is not in any refused set, so without this it interpolates verbatim and reparses as
 * attributes. The DOM path has no such hole - createElement refuses the same names - so
 * checking here is what makes the two modes agree.
 *
 * @internal
 */
function assertTagName(tag: string): string
{
    if (!TAG_NAME.test(tag))
    {
        throw new Error(`azeroth: refusing to render <${ JSON.stringify(tag) }> - a tag name must start with a letter `
            + 'and contain only letters, digits, "-", "_", "." or ":". A name carrying anything else would be written '
            + 'into the markup as attributes or a second tag. Pass the attributes as props instead.');
    }
    return tag;
}

/**
 * Whether a `<script>` with these props would RUN. A missing `type`, a non-string one (a
 * reactive `type` cannot be proven inert at creation), and a JavaScript MIME all count as
 * executing - the gate fails closed, since the cost of guessing wrong is code execution.
 *
 * @internal
 */
function scriptExecutes(props: Props): boolean
{
    if (!Object.hasOwn(props, 'type'))
    {
        return true;
    }

    const type = resolveValue(props.type);

    // A non-string type (a reactive one) cannot be proven inert at creation, so it fails
    // closed here; the MIME judgement itself is the shared predicate's.
    return typeof type !== 'string' || scriptTypeExecutes(type);
}

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
    return untrack(() => resolveThunks(value));
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
 * `value`, `checked`, `selected` and `disabled` are DOM properties on the client, but their
 * correct initial representation on the server IS the matching attribute, which these rules
 * already produce.
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
function serializeAttrs(props: Props, tag?: string): string
{
    let out = '';

    for (const [key, rawValue] of Object.entries(props))
    {
        // Refs never serialize, but the ref-value rule still holds (mirroring the handler
        // gate below): the same three "no ref" values pass here and in applyRef, and anything
        // else throws the same rule text, so no mode accepts a program another refuses.
        if (key === 'ref')
        {
            if (rawValue !== null && rawValue !== undefined && rawValue !== false
                && typeof rawValue !== 'function'
                && !(typeof rawValue === 'object' && 'current' in rawValue))
            {
                throw new TypeError(refValueMessage(typeof rawValue));
            }
            continue;
        }

        // Handlers never serialize, but the handler-value rule still holds: the same three
        // "no handler" values pass here and in attachEvent, and anything else throws the
        // same rule text, so no mode accepts a program another refuses.
        const eventType = hostEventType(key);
        if (eventType !== null)
        {
            if (rawValue !== null && rawValue !== undefined && rawValue !== false && typeof rawValue !== 'function')
            {
                throw new TypeError(handlerValueMessage(canonicalHandlerName(eventType), typeof rawValue));
            }
            continue;
        }
        if (isReservedHostAttribute(key))
        {
            throw new TypeError(reservedHostAttributeMessage(key));
        }

        if (CONTENT_PROPERTIES.has(key))
        {
            continue;
        }

        const value = resolveValue(rawValue);

        // Gated on the RESOLVED value, exactly as the DOM path gates the value its effect
        // resolved: a reactive `href={() => url()}` must meet the same policy as a literal one,
        // and checking the raw thunk here would see a function and wave every reactive prop past.
        assertSafeAttribute(key, value, tag);

        // `<select value>` has no attribute form; the selection is expressed as `selected` on the
        // matching <option> (see serializeElement). Emitting it would be inert markup that makes
        // the pre-hydration paint disagree with the client render.
        if (tag !== undefined && isChildResolvedProperty(key, tag))
        {
            continue;
        }

        if (isAriaBoolean(key, value))
        {
            out += ` ${ key }="${ String(value) }"`;
            continue;
        }

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
function serializeChildren(children: Child[]): string
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
 * else `textContent` (escaped), else the serialized children. On a raw-text
 * element (`<script>`/`<style>`) the same precedence holds, but either content
 * property is breakout-neutralized instead of entity-escaped. Void elements
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

    const attrs = serializeAttrs(props, tagName);

    if (VOID_ELEMENTS.has(tagName))
    {
        return ssr(`<${ tagName }${ attrs }>`);
    }

    // Raw-text element (`<script>`/`<style>`): content is CDATA, emitted without HTML-escaping.
    // Entity-escaping would corrupt the CSS/JSON-LD, since a browser does not decode entities
    // inside these elements - which is also why `textContent` takes the breakout transform here
    // rather than escapeText. The content properties keep their usual precedence: the DOM path
    // assigns them verbatim on these elements too, so skipping them shipped an EMPTY element to
    // every non-hydrating reader while the browser render carried the content. Only the
    // sequences that could TERMINATE the element are neutralized (see neutralizeRawText), so a
    // content value can never close the tag and continue as live markup.
    if (RAW_TEXT_ELEMENTS.has(tagName))
    {
        let raw: string;
        if ('innerHTML' in props)
        {
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- innerHTML is caller-trusted raw content; non-string input is caller error surfaced visibly
            raw = String(resolveValue(props.innerHTML) ?? '');
        }
        else if ('textContent' in props)
        {
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- textContent coerces like the DOM property; non-string input is caller error surfaced visibly
            raw = String(resolveValue(props.textContent) ?? '');
        }
        else
        {
            raw = '';
            for (const child of children)
            {
                if (child === null || child === undefined || child === false)
                {
                    continue;
                }
                // eslint-disable-next-line @typescript-eslint/no-base-to-string -- raw-text content is caller-trusted CDATA; a reactive value is resolved, any non-string is coerced like the DOM path
                raw += String(typeof child === 'function' ? resolveValue(child) ?? '' : child);
            }
        }
        return ssr(`<${ tagName }${ attrs }>${ neutralizeRawText(tagName, raw) }</${ tagName }>`);
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

    if (tagName === 'select')
    {
        // Children are ALREADY serialized strings here: h(<option>) ran before h(<select>),
        // because arguments evaluate inner-to-outer. So the selection is applied to the emitted
        // markup rather than published to the children while they render.
        const desired = resolveValue(props.value);
        if (desired !== null && desired !== undefined)
        {
            // A `multiple` select selects a SET, and the client has a dedicated array branch for
            // it. Coercing here instead - String(['de','jp']) is "de,jp" - matched no option, so
            // the server painted NOTHING while the client selected both, and the two writers
            // disagreed by construction. A single-entry array happened to work, which is why it
            // went unnoticed.
            const multiple = resolveValue(props.multiple) === true || props.multiple === '';

            // Options that are not here yet: a pending Suspense boundary inside this select emits
            // its real options in a continuation chunk, long after this tag is flushed. The value
            // IS known now, so it rides along on the boundary and the chunk marks its own options
            // (see chunkFor). Set-once, so the INNERMOST select wins - children serialize first.
            const session = currentStreamSession();
            if (session !== null)
            {
                for (const match of inner.matchAll(/<!--azc:suspense:(\d+)-->/g))
                {
                    const boundary = session.boundaryOf(Number(match[1]));
                    if (boundary !== undefined && boundary.select === undefined)
                    {
                        boundary.select = {
                            desired: Array.isArray(desired)
                                ? (desired as unknown[]).map((entry) => String(entry))
                                // eslint-disable-next-line @typescript-eslint/no-base-to-string -- mirrors the DOM path
                                : String(desired),
                            multiple
                        };
                    }
                }
            }

            inner = Array.isArray(desired) && multiple
                ? markSelectedOptions(inner, (desired as unknown[]).map((entry) => String(entry)))
                // eslint-disable-next-line @typescript-eslint/no-base-to-string -- mirrors the DOM path, where el.value = v coerces whatever it is given
                : markSelectedOption(inner, String(desired));
        }
    }

    return ssr(`<${ tagName }${ attrs }>${ inner }</${ tagName }>`);
}

/**
 * Applies a `<select>`'s value to its already-serialized options by marking the matching one
 * `selected`.
 *
 * This works on the emitted STRING rather than on the children, because by the time a select
 * serializes, its options are already HTML: `h('option', ...)` runs before `h('select', ...)`,
 * since arguments evaluate inner-to-outer. There is no point at which the select could publish
 * its value to children that have not rendered yet.
 *
 * Two rules, both matching what the DOM does when `select.value` is assigned:
 * - the FIRST matching option wins;
 * - an authored `selected` on any option is dropped, because the select's value is the later
 *   writer. Leaving it would mark two options and the browser would take the last one, so the
 *   server paint would disagree with the client render.
 *
 * @internal
 * @param inner - The serialized children of the select.
 * @param desired - The select's value.
 * @returns The children with at most one option marked selected.
 */
export function markSelectedOption(inner: string, desired: string): string
{
    // TWO passes, and the order is load-bearing. Stripping an authored `selected` while walking
    // would drop it even when NOTHING matches - the server would then paint no selection at all
    // while the client, whose apply is match-gated, leaves the authored option selected. The strip
    // exists only to stop TWO options being marked, which cannot happen if none matched.
    const winner = findWinningOption(inner, desired);
    if (winner === -1)
    {
        return inner;
    }

    let out = '';
    let at = 0;

    for (;;)
    {
        const open = nextOptionTag(inner, at);
        if (open === -1)
        {
            return out + inner.slice(at);
        }
        const tagEnd = findTagEnd(inner, open);
        if (tagEnd === -1)
        {
            return out + inner.slice(at);
        }

        out += inner.slice(at, open);
        let tag = stripSelected(inner.slice(open, tagEnd));
        if (open === winner)
        {
            tag += ' selected=""';
        }
        out += `${ tag }>`;
        at = tagEnd + 1;
    }
}

/**
 * Marks EVERY option whose value is in `desired`, for a `<select multiple>`.
 *
 * The single-value marker cannot serve here: it stops at the first match, and coercing the array
 * to a string (which is what the DOM does for a non-multiple select) matches nothing, so the
 * server emitted no selection at all while the client selected the whole set.
 *
 * @internal
 * @param inner - The serialized children of the select.
 * @param desired - The values to select.
 * @returns The children with each matching option marked.
 */
export function markSelectedOptions(inner: string, desired: readonly string[]): string
{
    const wanted = new Set(desired);

    // Same two-pass rule as the single-value marker: when the array is non-empty but NOTHING in
    // it is present, an authored `selected` must stand - the client's match gate leaves the
    // selection alone in that case, and stripping here made the two writers disagree. An EMPTY
    // array is different: it is an explicit "select nothing", which the client now honours by
    // deselecting everything, so the strip proceeds with no member to mark.
    if (wanted.size > 0)
    {
        let anyPresent = false;
        let scanAt = 0;
        for (;;)
        {
            const open = nextOptionTag(inner, scanAt);
            if (open === -1)
            {
                break;
            }
            const tagEnd = findTagEnd(inner, open);
            if (tagEnd === -1)
            {
                break;
            }
            const tag = inner.slice(open, tagEnd);
            if (wanted.has(attrValue(tag, 'value') ?? optionText(inner, tagEnd + 1)))
            {
                anyPresent = true;
                break;
            }
            scanAt = tagEnd + 1;
        }
        if (!anyPresent)
        {
            return inner;
        }
    }

    let out = '';
    let at = 0;

    for (;;)
    {
        const open = nextOptionTag(inner, at);
        if (open === -1)
        {
            return out + inner.slice(at);
        }
        const tagEnd = findTagEnd(inner, open);
        if (tagEnd === -1)
        {
            return out + inner.slice(at);
        }

        out += inner.slice(at, open);
        // The select's value decides the whole set, so an authored `selected` on a non-member is
        // dropped for the same reason it is in the single-value case.
        let tag = stripSelected(inner.slice(open, tagEnd));
        const value = attrValue(tag, 'value') ?? optionText(inner, tagEnd + 1);
        if (wanted.has(value))
        {
            tag += ' selected=""';
        }
        out += `${ tag }>`;
        at = tagEnd + 1;
    }
}

/** Index of the first `<option` tag at or after `from`, or -1. `<optgroup>` shares the prefix. */
function nextOptionTag(inner: string, from: number): number
{
    let at = from;
    for (;;)
    {
        const open = inner.indexOf('<option', at);
        if (open === -1)
        {
            return -1;
        }
        const after = inner[open + '<option'.length];
        if (after === ' ' || after === '>' || after === '\t' || after === '\n' || after === '\r')
        {
            return open;
        }
        at = open + '<option'.length;
    }
}

/** Start index of the FIRST option carrying `desired`, matching `select.value = x`, or -1. */
function findWinningOption(inner: string, desired: string): number
{
    let at = 0;
    for (;;)
    {
        const open = nextOptionTag(inner, at);
        if (open === -1)
        {
            return -1;
        }
        const tagEnd = findTagEnd(inner, open);
        if (tagEnd === -1)
        {
            return -1;
        }
        const tag = inner.slice(open, tagEnd);
        if ((attrValue(tag, 'value') ?? optionText(inner, tagEnd + 1)) === desired)
        {
            return open;
        }
        at = tagEnd + 1;
    }
}

/**
 * Removes a `selected` ATTRIBUTE from a serialized open tag, leaving everything else identical.
 *
 * Scanning matters here rather than a regex: `/\s+selected(="[^"]*")?/` also matches the word
 * inside quoted VALUES, so `class="row selected"` lost its class and
 * `title="Currently selected country"` lost a word from its prose. That is silent corruption of
 * author content, and it is final on a page that runs without JS.
 *
 * @internal
 */
function stripSelected(tag: string): string
{
    // Everything up to the end of the tag name is kept verbatim; attribute names start after it.
    let index = '<option'.length;
    let out = tag.slice(0, index);

    while (index < tag.length)
    {
        const gapStart = index;
        while (index < tag.length && /\s/.test(tag[index] as string))
        {
            index += 1;
        }
        if (index >= tag.length)
        {
            out += tag.slice(gapStart);
            break;
        }

        const nameStart = index;
        while (index < tag.length && !/[\s=]/.test(tag[index] as string))
        {
            index += 1;
        }
        const name = tag.slice(nameStart, index);

        // Consume `= value` when present, so a value can never be mistaken for the next name.
        let end = index;
        let scan = index;
        while (scan < tag.length && /\s/.test(tag[scan] as string))
        {
            scan += 1;
        }
        if (tag[scan] === '=')
        {
            scan += 1;
            while (scan < tag.length && /\s/.test(tag[scan] as string))
            {
                scan += 1;
            }
            const quote = tag[scan];
            if (quote === '"' || quote === '\'')
            {
                scan += 1;
                while (scan < tag.length && tag[scan] !== quote)
                {
                    scan += 1;
                }
                scan += 1;
            }
            else
            {
                while (scan < tag.length && !/\s/.test(tag[scan] as string))
                {
                    scan += 1;
                }
            }
            end = scan;
        }

        if (name.toLowerCase() !== 'selected')
        {
            out += tag.slice(gapStart, end);
        }
        index = end;
    }

    return out;
}

/** Index of the `>` closing the tag that starts at `from`, skipping quoted attribute values. */
function findTagEnd(html: string, from: number): number
{
    let quote = '';
    for (let i = from; i < html.length; i += 1)
    {
        const c = html[i] as string;
        if (quote !== '')
        {
            if (c === quote)
            {
                quote = '';
            }
            continue;
        }
        if (c === '"' || c === '\'')
        {
            quote = c;
            continue;
        }
        if (c === '>')
        {
            return i;
        }
    }
    return -1;
}

/** A quoted attribute's value from a serialized open tag, entity-decoded, or null when absent. */
function attrValue(tag: string, name: string): string | null
{
    const match = new RegExp(`\\s${ name }="([^"]*)"`).exec(tag);
    return match === null ? null : decodeAttr(match[1] as string);
}

/** Reverses the escaping serializeAttrs applies, so a value compares against the raw string. */
function decodeAttr(value: string): string
{
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * An option with no `value` attribute takes its text, per the HTML `option.value` rule:
 * leading/trailing whitespace stripped and internal runs collapsed. Markers and nested tags are
 * removed first, so a compiled option (`<option><!--[-->de<!--]--></option>`) compares equal to
 * the hand-written one.
 */
function optionText(html: string, from: number): string
{
    const close = html.indexOf('</option>', from);
    const raw = close === -1 ? html.slice(from) : html.slice(from, close);
    return decodeAttr(raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')).trim().replace(/\s+/g, ' ');
}
