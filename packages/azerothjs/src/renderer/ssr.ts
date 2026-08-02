/**
 * MODULE: renderer/ssr (internal)
 *
 * The element-specific half of server-side rendering: turning an h() call into an HTML string.
 * It mirrors, branch for branch, what applyProps/setProperty/appendChild do in h.ts's DOM path,
 * so the markup the server produces is structurally identical to what the browser would build -
 * which is what lets hydration adopt it node-for-node. The generic DOM-free pieces (escaping,
 * child serialization, the SSRNode wrapper) live in azerothjs's ssr; this file owns
 * the HTML-element specifics (tag names, void elements, attribute-vs-property rules). These
 * serializers are package-internal (consumed by h.ts in string mode), not public API.
 *
 * It also owns the render-safety gate - assertSafeTag / assertSafeAttribute - which BOTH
 * render modes call, so a tag or a value one mode refuses can never be written by the other.
 * The only public symbols here are the two escape hatches that opt a single value out of it.
 */

import type { Props, Child } from './types.ts';
import { untrack, escapeText, escapeAttr, ssr } from '../reactivity/index.ts';
import { resolveThunks, serializeChild } from '../reactivity/internal.ts';
import type { SSRNode } from '../reactivity/index.ts';
import {
    hostEventType,
    isReservedHostAttribute,
    isEventNamespace,
    refValueMessage,
    reservedHostAttributeMessage,
    handlerValueMessage,
    canonicalHandlerName,
    CONTENT_PROPERTIES,
    VOID_ELEMENTS,
    RAW_TEXT_ELEMENTS
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

/**
 * Attributes the browser resolves as a URL and then FETCHES or NAVIGATES to. A scheme it
 * treats as code (`javascript:`, `vbscript:`) or as a document it will run script from
 * (`data:text/html`, `data:image/svg+xml`) turns a rendered value into execution - which is
 * what every "user-supplied link" injection reduces to. Names are matched lowercased, as
 * HTML attribute names are case-insensitive.
 *
 * @internal
 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set
([
    'href',
    'src',
    'action',
    'formaction',
    'poster',
    'xlink:href',
    'data'
]);

/**
 * ASCII whitespace and C0 controls, which browsers STRIP before resolving a URL: `java\tscript:`
 * and a leading-newline scheme both reach the parser as a real `javascript:` scheme. Testing the
 * raw string instead of the normalized one is exactly how a scheme classifier gets bypassed, so
 * the candidate is normalized the way the browser normalizes it first.
 *
 * @internal
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point: browsers remove them from a URL before resolving its scheme
const URL_CONTROL_CHARS = /[\x00-\x20]/g;

/** The scheme of a URL candidate, or no match for a relative URL. @internal */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * A `data:` URL carrying a non-SVG image. Inline images are legitimate and common, so they
 * stay allowed; `image/svg+xml` does NOT, because an SVG document carries script and runs it
 * when navigated to - a `data:image/svg+xml` href is a same-document XSS with an image's name.
 *
 * @internal
 */
const DATA_IMAGE_URL = /^data:image\/(?!svg)[a-z0-9.+-]+[;,]/i;

/** An `image/svg+xml` data URL, which is inert in an image context and scripted everywhere else. */
const DATA_SVG_URL = /^data:image\/svg\+xml[;,]/i;

/**
 * Tag+attribute pairs where the browser renders the URL as an IMAGE and nothing else. SVG
 * loaded there runs in the spec's secure static mode: no script, no external references, no
 * navigation - a guarantee every engine implements. Anywhere else (`<a href>`, `<iframe src>`,
 * a `<use xlink:href>`) an SVG document keeps its scripting, so the refusal stands there.
 *
 * @internal
 */
const IMAGE_URL_CONTEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['img', new Set(['src'])],
    ['video', new Set(['poster'])]
]);

/** Whether `tag[attribute]` is one of the image-only contexts above. */
function rendersAsImage(tag: string | undefined, name: string): boolean
{
    return tag !== undefined && IMAGE_URL_CONTEXT.get(tag.toLowerCase())?.has(name) === true;
}

/**
 * Tags refused outright: `<base>` rewrites where every relative URL on the page resolves to
 * (one injected tag re-points every link, form and script), and `<object>`/`<embed>` load a
 * document that runs script in this origin. `<iframe>` is deliberately NOT here - every video
 * and payment embed is one, and it is sandboxable and origin-isolated.
 *
 * @internal
 */
const REFUSED_TAGS: ReadonlySet<string> = new Set(['base', 'object', 'embed']);

/**
 * The `type` values a `<script>` can carry and still EXECUTE: the HTML JavaScript-MIME set,
 * plus `module` and the empty value (both mean "run this"). Any OTHER type is a data block the
 * browser never runs - `application/ld+json` is the documented case, and this serializer has
 * dedicated escaping for its content.
 *
 * @internal
 */
const JAVASCRIPT_MIME_TYPES: ReadonlySet<string> = new Set
([
    '',
    'module',
    'text/javascript',
    'application/javascript',
    'text/ecmascript',
    'application/ecmascript',
    'text/jscript',
    'text/livescript',
    'text/x-javascript',
    'text/x-ecmascript',
    'application/x-javascript',
    'application/x-ecmascript'
]);

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
 * unsafeUrl
 *
 * PURPOSE:
 * Marks one URL string as author-vetted, so the render-safety gate writes it verbatim into a
 * URL attribute (`href`, `src`, `action`, `formaction`, `poster`, `xlink:href`, `data`) even
 * when its scheme is one the framework otherwise refuses, and into `srcdoc`, which is refused
 * outright.
 *
 * WHY IT EXISTS:
 * The gate refuses `javascript:`, `vbscript:` and non-image `data:` URLs because a value that
 * reaches them is almost always user data that was never meant to be code. "Almost always" is
 * not "always": a bookmarklet builder, a generated SVG document, a legacy `javascript:void(0)`
 * anchor are real. Those get an explicit, greppable opt-in at the ONE call site that needs it,
 * instead of a global switch that turns the gate off for the whole app.
 *
 * WHEN TO USE:
 * When the URL is a literal in your own source, or you built it yourself from values you
 * validated.
 *
 * WHEN NOT TO USE:
 * On anything that came from a request, a database, a file, or a user - there is no vetting
 * left in the call, so this simply reinstates the vulnerability the gate exists to stop.
 *
 * @param value - The URL to write verbatim.
 * @returns An opaque marker that stringifies to `value`, typed as `string` so it drops into a
 *          prop unchanged.
 * @see {@link unsafeTag}
 * @example
 * h('a', { href: unsafeUrl('javascript:void(0)') }, 'legacy anchor');
 * h('img', { src: unsafeUrl(`data:image/svg+xml,${ encodeURIComponent(chart) }`) });
 */
export function unsafeUrl(value: string): string
{
    return new UnsafeValue(value, 'url') as unknown as string;
}

/**
 * unsafeTag
 *
 * PURPOSE:
 * Marks one tag name as author-vetted, so h() creates it even when it is a tag the
 * render-safety gate refuses: an executing `<script>`, or `<base>` / `<object>` / `<embed>`.
 *
 * WHY IT EXISTS:
 * Those four tags are how injected markup gets from "content" to "code", so h() refuses them by
 * default. An app that genuinely needs one - injecting a third-party loader, an analytics
 * snippet - names itself at the call site rather than the framework leaving the door open for
 * everyone. A NON-executing script (`type="application/ld+json"` and any other data block) is
 * allowed without this.
 *
 * WHEN TO USE:
 * With a literal tag name for content you control.
 *
 * WHEN NOT TO USE:
 * With a tag name that came from data. A `<script>` whose content is also data is remote code
 * execution in the visitor's session, no matter how the tag name was spelled.
 *
 * @param name - The tag name to create.
 * @returns An opaque marker that stringifies to `name`, typed as `string` so it drops into h()
 *          unchanged.
 * @see {@link unsafeUrl}
 * @example
 * h(unsafeTag('script'), { src: 'https://cdn.example.com/widget.js', async: true });
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
        throw new Error(`azeroth: refusing the ${ JSON.stringify(key) } attribute - srcdoc is an inline DOCUMENT, `
            + 'so its value is markup that runs with the embedding page\'s privileges. Point the frame at a real URL, '
            + 'or pass unsafeUrl(...) if the content is yours.');
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
            throw new Error(`azeroth: refusing ${ JSON.stringify(key) }=${ JSON.stringify(written) } - the browser would `
                + 'execute this URL rather than fetch it (javascript:/vbscript:, or a data: URL that is not an image - '
                + 'an SVG data URL is accepted only on <img src> and <video poster>, where it cannot script). '
                + 'Validate the value, or pass unsafeUrl(...) if it is deliberate.');
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
 * Whether a URL hands the browser CODE rather than a resource, judged on the string the
 * browser would actually resolve.
 *
 * @internal
 */
function isExecutableUrl(value: string, imageContext = false): boolean
{
    const candidate = value.replace(URL_CONTROL_CHARS, '');
    const scheme = URL_SCHEME.exec(candidate)?.[1]?.toLowerCase();

    if (scheme === undefined)
    {
        return false;
    }

    // Every data: URL is same-origin-ish content the browser parses; only a real image is
    // inert, so the allowance is stated positively. SVG joins that allowance ONLY where the
    // browser renders it as an image, which strips its scripting.
    if (scheme === 'data')
    {
        return !DATA_IMAGE_URL.test(candidate) && !(imageContext && DATA_SVG_URL.test(candidate));
    }

    return scheme === 'javascript' || scheme === 'vbscript';
}

/**
 * Validates the tag h() was handed, in every render mode, and returns the concrete tag name to
 * build with (unwrapping an {@link unsafeTag} marker). The refused set is the markup that turns
 * content into execution - see {@link REFUSED_TAGS} for why `<iframe>` is not in it, and
 * {@link JAVASCRIPT_MIME_TYPES} for why a data-block `<script>` is allowed.
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
        throw new Error(`azeroth: refusing to render <${ name }> - it loads a document that runs script in this origin `
            + '(or, for <base>, silently re-targets every relative URL on the page). Use <iframe> for an embed, '
            + `or unsafeTag('${ name }') if it is deliberate.`);
    }

    if (name === 'script' && scriptExecutes(props))
    {
        throw new Error('azeroth: refusing to render an executable <script> - its content would run with the page\'s '
            + 'privileges. A data block (type="application/ld+json" or any other non-JavaScript type) renders as-is; '
            + 'pass unsafeTag(\'script\') if the execution is deliberate.');
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

    if (typeof type !== 'string')
    {
        return true;
    }

    // A MIME's parameters (`;charset=utf-8`) do not change what it is.
    return JAVASCRIPT_MIME_TYPES.has(type.trim().toLowerCase().split(';')[0] ?? '');
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
    const attrs = serializeAttrs(props, tagName);

    if (VOID_ELEMENTS.has(tagName))
    {
        return ssr(`<${ tagName }${ attrs }>`);
    }

    // Raw-text element (`<script>`/`<style>`): content is CDATA, emitted without HTML-escaping.
    // The compiler feeds a single literal string here; entity-escaping it would corrupt the
    // CSS/JSON-LD, since a browser does not decode entities inside these elements. Only the
    // sequences that could TERMINATE the element are neutralized (see neutralizeRawText), so a
    // child value can never close the tag and continue as live markup.
    if (RAW_TEXT_ELEMENTS.has(tagName))
    {
        let raw = '';
        for (const child of children)
        {
            if (child === null || child === undefined || child === false)
            {
                continue;
            }
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- raw-text content is caller-trusted CDATA; a reactive value is resolved, any non-string is coerced like the DOM path
            raw += String(typeof child === 'function' ? resolveValue(child) ?? '' : child);
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

    return ssr(`<${ tagName }${ attrs }>${ inner }</${ tagName }>`);
}
