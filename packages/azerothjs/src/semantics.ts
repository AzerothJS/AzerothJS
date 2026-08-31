/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The language's shared vocabulary: the single owner of every markup fact that more than one implementation consumes: the
 * compiler (lowering, diagnostics, the editor projection), the runtime (h(), the SSR
 * serializer, hydration, delegation), and the tooling satellites (language server, ESLint
 * plugin). A rule defined here is defined NOWHERE else; two backends that each restate a
 * language rule can drift into assigning one program two meanings, and one module cannot.
 *
 * Zero imports by construction - this file must be consumable from any package without
 * dragging either the compiler or the renderer along.
 */

/**
 * Classifies a HOST-element attribute name as an event handler and returns the DOM event
 * type it denotes, or null when the name is not handler-form. Handler-form is `on` followed
 * by a character that is not a lowercase letter: `onClick` and `on-retry` are handler-form
 * (`click`, `-retry`); `onclick` and `online` are not.
 *
 * Component attributes never pass through this classifier - a component attribute is a
 * props-object KEY, preserved verbatim.
 *
 * @param name - The attribute or prop name.
 * @returns The lowercase DOM event type, or null when `name` is not handler-form.
 * @example
 * ```ts
 * hostEventType('onClick'); // 'click'
 * hostEventType('onclick'); // null (reserved, see isReservedHostAttribute)
 * hostEventType('online');  // null
 * ```
 */
export function hostEventType(name: string): string | null
{
    const third = name[2];
    if (name.length > 2 && name.startsWith('on') && third !== undefined && third === third.toUpperCase())
    {
        return name.slice(2).toLowerCase();
    }
    return null;
}

/** The whole `on*` name family, case-insensitive - handler-form plus the reserved remainder. */
const EVENT_NAMESPACE = /^on/i;

/**
 * True for any name in the `on*` family, handler-form or not. This is the SSR safety
 * boundary and hydration's attribute-strip domain: a server-rendered `on*` attribute string
 * is compiled by the browser into a live handler, so no path may ever emit one.
 */
export function isEventNamespace(name: string): boolean
{
    return EVENT_NAMESPACE.test(name);
}

/**
 * True for a host attribute name that sits in the `on*` namespace WITHOUT being
 * handler-form (`onclick`, `once`, `ONCLICK`). These names are reserved: HTML compiles
 * `on*` content attributes into handlers, so they cannot "pass through as attributes",
 * and they are not handler-form, so they name no event. A program using one is rejected
 * at compile time and refused by every runtime entry point with the same rule.
 */
export function isReservedHostAttribute(name: string): boolean
{
    return isEventNamespace(name) && hostEventType(name) === null;
}

/** The mechanical camelCase repair for a reserved name, or null when none exists. */
function camelHandlerSuggestion(name: string): string | null
{
    const first = name[2];
    if (first === undefined)
    {
        return null;
    }
    const camel = `on${ first.toUpperCase() }${ name.slice(3).toLowerCase() }`;
    return camel !== name && hostEventType(camel) !== null ? camel : null;
}

/** The one rule text for a reserved host `on*` name, shared by compiler and runtime. */
export function reservedHostAttributeMessage(name: string): string
{
    const camel = camelHandlerSuggestion(name);
    const hint = camel === null
        ? 'use a data-* attribute for data'
        : `write '${ camel }' to handle the '${ hostEventType(camel) }' event, or use a data-* attribute for data`;
    return `'${ name }' - the on* namespace on host elements is reserved for event handlers; ${ hint }.`;
}

/** The one rule text for a handler-form attribute whose value is not a function. */
export function handlerValueMessage(name: string, got: string): string
{
    return `'${ name }' expects a function handler (or null/undefined/false for none); got ${ got }.`;
}

/** The one rule text for a `ref` whose value is not a callback, a createRef box, or "no ref". */
export function refValueMessage(got: string): string
{
    return `'ref' expects a callback or a createRef box (or null/undefined/false for none); got ${ got }.`;
}

/**
 * The canonical handler-form name for a lowercase event type: `click` -> `onClick`.
 * Provably lossless - `hostEventType(canonicalHandlerName(t)) === t` for every lowercase
 * type - so emitters and error messages may reconstruct the name without carrying it.
 */
export function canonicalHandlerName(type: string): string
{
    return `on${ (type[0] ?? '').toUpperCase() }${ type.slice(1) }`;
}

/**
 * The two-way binding write-back rule: which native event a bound prop writes back on, and
 * the callback key a bound COMPONENT receives. `checked` writes back on `change`;
 * everything else on `input`.
 */
export function bindWriteBack(prop: string): { event: 'input' | 'change'; callback: 'onInput' | 'onChange' }
{
    return prop === 'checked'
        ? { event: 'change', callback: 'onChange' }
        : { event: 'input', callback: 'onInput' };
}

/**
 * The DOM properties that OWN an element's content. They are mutually exclusive with
 * children in every mode (see {@link contentChildrenMessage}); as attributes they would be
 * inert strings, so every path writes them as properties and none may bake them into a
 * static template.
 */
export const CONTENT_PROPERTIES: ReadonlySet<string> = new Set(['innerHTML', 'textContent']);

/** The one rule text for combining a content property with children. */
export function contentChildrenMessage(prop: string): string
{
    return `'${ prop }' and element children are mutually exclusive - the content property owns the element's content.`;
}

/**
 * Attribute names written as live DOM properties on the client. For most of them the server
 * representation is the matching attribute (`value="x"`), which the browser parses back into
 * the property, so the two writers agree; `innerHTML`/`textContent` additionally own the
 * element's content (see {@link CONTENT_PROPERTIES}).
 *
 * The one exception is `value` on `<select>` - see {@link isChildResolvedProperty}. Treating
 * that as attribute-backed is what made four separate writers wrong the same way.
 */
export const DOM_PROPERTIES: ReadonlySet<string> = new Set([
    'value', 'checked', 'selected', 'disabled', 'innerHTML', 'textContent'
]);

/**
 * Whether a property's value is resolved by the element's CHILDREN rather than by the element
 * itself. `value` on `<select>` is the only one, and it breaks three assumptions at once:
 *
 * - It has NO content attribute. `<select value="de">` is meaningless HTML, so the server must
 *   express the selection as `selected` on the matching `<option>` instead.
 * - Assigning it while no matching `<option>` exists is a SILENT no-op, so a writer that runs
 *   before the children are in place writes nothing and reports no error.
 * - It therefore must not bake into a static template, where there is no writer left to re-run.
 *
 * Keyed on BOTH name and tag deliberately: `value` on `<input>`, `<textarea>` and `<option>` is
 * genuinely attribute-backed, so a name-only check would break all three.
 *
 * @param prop - The property name.
 * @param tag - The element's tag name, in any case.
 * @returns true when the property must be written after children and serialized onto them.
 */
export function isChildResolvedProperty(prop: string, tag: string): boolean
{
    // `prop` first: the common case fails on one string compare and never lowercases the tag.
    return prop === 'value' && tag.toLowerCase() === 'select';
}

/**
 * Whether `name` is an ARIA attribute, whose booleans are the STRINGS "true"/"false" and never
 * HTML boolean attributes. `aria-expanded={false}` must serialize as `aria-expanded="false"`:
 * dropping it loses the state entirely, and writing `={true}` bare as `aria-expanded=""` reads
 * as neither true nor false to an accessibility tree.
 *
 * The compiler needs this too - a constant-folded attribute is decided before any writer runs -
 * so the fact lives here rather than in a renderer.
 */
export function isAriaStateAttribute(name: string): boolean
{
    return name.startsWith('aria-');
}

/** HTML void elements: no closing tag and no children (`<br>`, `<img>`, ...). */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** The one rule text for children (or a closing tag) on a void element. */
export function voidChildrenMessage(tag: string): string
{
    return `Void element <${ tag }> cannot have children or a closing tag; write <${ tag } />.`;
}

/**
 * HTML raw-text elements: their content is CDATA, not markup. `<style>`/`<script>` carry
 * `{`, `<`, and `&` that must stay LITERAL - parsers read their content verbatim and
 * serializers emit it unescaped.
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * Event types attached through the shared document-level dispatcher instead of a
 * per-element listener. This set is part of the OBSERVABLE event contract, identical in
 * every render mode: for these types, a non-framework ancestor listener that calls
 * stopPropagation() suppresses the handler (the event never reaches the document); types
 * outside the set attach directly and fire at the element. Everything here reliably
 * bubbles in browsers and happy-dom; non-bubbling types (focus, blur, mouseenter, ...)
 * must stay per-element.
 */
export const DELEGATED_EVENTS: ReadonlySet<string> = new Set([
    'click', 'dblclick', 'contextmenu',
    'input', 'change',
    'keydown', 'keyup', 'keypress',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
    'pointerdown', 'pointerup', 'pointermove',
    'touchstart', 'touchend', 'touchmove'
]);

/** Whether handlers for this (lowercase) event type go through the document dispatcher. */
export function isDelegatedEvent(type: string): boolean
{
    return DELEGATED_EVENTS.has(type);
}

/**
 * The canonical handler-name vocabulary for completions and docs: the camelCase authoring
 * names for the DOM events users actually write handlers for. The DOM event type derives
 * mechanically via {@link hostEventType}; the reverse (interior capitalization,
 * `dblclick` -> `onDblClick`) does not, so the camel forms are decided once, here.
 * Presentation data, not a gate - handler-form names outside this list are still valid.
 */
export const EVENT_HANDLER_NAMES: readonly string[] = [
    'onClick', 'onDblClick', 'onContextMenu',
    'onInput', 'onChange', 'onSubmit', 'onReset', 'onInvalid',
    'onKeyDown', 'onKeyUp', 'onKeyPress',
    'onFocus', 'onBlur', 'onFocusIn', 'onFocusOut',
    'onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseOver', 'onMouseOut', 'onMouseEnter', 'onMouseLeave',
    'onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerEnter', 'onPointerLeave', 'onPointerCancel',
    'onTouchStart', 'onTouchEnd', 'onTouchMove', 'onTouchCancel',
    'onWheel', 'onScroll',
    'onDrag', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDrop',
    'onCopy', 'onCut', 'onPaste',
    'onLoad', 'onError', 'onAbort',
    'onAnimationStart', 'onAnimationEnd', 'onAnimationIteration', 'onTransitionEnd',
    'onPlay', 'onPause', 'onEnded', 'onCanPlay', 'onTimeUpdate', 'onVolumeChange'
];

/**
 * The built-in components the compiler auto-imports and the tooling documents. Order is
 * presentation order for completions.
 */
export const BUILTIN_COMPONENTS: readonly string[] = [
    'Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic',
    'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'
];

/** Set form of {@link BUILTIN_COMPONENTS} for membership tests. */
export const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_COMPONENTS);

/**
 * The tag-domain rule: a capitalized or dotted tag is a COMPONENT reference (attributes
 * are verbatim props keys); anything else is a host element (attributes follow the DOM
 * rules above).
 */
export function isComponentTag(tag: string): boolean
{
    return /[A-Z]/.test(tag[0] ?? '') || tag.includes('.');
}

/**
 * Component props that are lazy render factories (called when shown), not reactive
 * values: `fallback` for Show/Switch/Suspense, `component` for Dynamic.
 */
export const FACTORY_ATTRS: ReadonlySet<string> = new Set(['fallback', 'component']);

/**
 * The components whose props may BE factories: the builtins plus Routes
 * (framework-shipped but user-imported, so deliberately not auto-imported). Factory
 * emission is part of a COMPONENT's contract, never a prop NAME's - a user component
 * with a prop that happens to be called `fallback` receives the plain value.
 */
export const FACTORY_COMPONENTS: ReadonlySet<string> = new Set([...BUILTIN_COMPONENTS, 'Routes']);

/** True when `tag`'s `name` prop follows the lazy-factory contract. */
export function isFactoryProp(tag: string, name: string): boolean
{
    return FACTORY_COMPONENTS.has(tag) && FACTORY_ATTRS.has(name);
}

/**
 * Control-flow binding attributes: the narrowed reactive NAMES a builtin declares for
 * its subtree - `<Show when={x} let={x}>`, `<For each={xs} let={item} index={i}>`,
 * and Match like Show. The attribute value is a BARE IDENTIFIER, not an expression;
 * a declared name reads like state (bare, compiler-unwrapped) inside the subtree.
 *
 * Gated per TAG for the same reason as {@link FACTORY_ATTRS}: binding is part of a
 * builtin's contract, never an attribute NAME's - a user component with a prop that
 * happens to be called `let` receives the plain value.
 */
export const BINDING_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['Show', new Set(['let'])],
    ['Match', new Set(['let'])],
    ['For', new Set(['let', 'index'])]
]);

/** True when `tag`'s `name` attribute declares a subtree binding. */
export function isBindingAttr(tag: string, name: string): boolean
{
    return BINDING_ATTRS.get(tag)?.has(name) ?? false;
}

/**
 * djb2 to base36 over CSS rule text: the scope suffix appended to every class name the text
 * defines. Deterministic across runs and across processes, which is the whole mechanism -
 * identical rules dedupe to one stylesheet, and the server and the client independently
 * compute the SAME class names for the same rules.
 *
 * Nothing but the rule text may enter the input. A filename, module id or counter would make
 * the two sides disagree, and the failure is silent: hydration overwrites `class` without
 * comparing it, so the page would simply render unstyled.
 *
 * @param input - The raw CSS text.
 * @returns A short base36 scope suffix.
 * @see {@link scopeSelectors} - the rewrite that consumes the scope.
 */
export function hashCss(input: string): string
{
    let hash = 5381;
    for (let i = 0; i < input.length; i++)
    {
        hash = (((hash << 5) + hash) + input.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** A class-selector identifier after the `.`; sticky, so it matches in place. */
const CLASS_IDENT = /-?[_a-zA-Z][\w-]*/y;

/**
 * Rewrites every `.name` class selector in `cssText` to `.name_<scope>`, recording each base
 * name against its scoped form in `classMap`.
 *
 * Only CLASS selectors are rewritten. Element, id, attribute and custom-property names stay
 * global, so `div { margin: 0 }` inside a scoped block still applies page-wide - the scoping
 * unit is the class, not the block.
 *
 * Quoted strings, `url(...)` bodies and comments are copied VERBATIM, because a dotted token
 * inside them is content rather than a selector. Rewriting `url(./logo.png)` or
 * `content: ".done"` would 404 the asset or corrupt the value while the class names kept
 * working, so the breakage would be silent.
 *
 * The CSS is never parsed, so nesting, `@media`, `@layer`, `@supports`, `@keyframes` and any
 * future syntax pass through untouched.
 *
 * Lives here rather than in the renderer because BOTH the runtime `css` template and the
 * compiler's `style { }` section run it - over the same text, to the same scope - and the two
 * agreeing is what makes a class written in markup resolve to the rule that styles it.
 *
 * @param cssText - The raw CSS.
 * @param scope - The suffix from {@link hashCss}.
 * @param classMap - Filled in place: base class name to scoped class name.
 * @returns The rewritten CSS.
 * @example
 * ```ts
 * const map: Record<string, string> = {};
 * scopeSelectors('.btn:hover { color: red }', 'a1b2', map);
 * // '.btn_a1b2:hover { color: red }', map.btn === 'btn_a1b2'
 * ```
 */
export function scopeSelectors(cssText: string, scope: string, classMap: Record<string, string>): string
{
    const n = cssText.length;
    let out = '';
    let i = 0;

    // Copies a quoted string verbatim, honouring backslash escapes, and returns the index one
    // past the closing quote.
    const copyString = (from: number): number =>
    {
        const quote = cssText.charAt(from);
        let j = from + 1;
        while (j < n)
        {
            const c = cssText.charAt(j);
            if (c === '\\')
            {
                j += 2;
                continue;
            }
            j++;
            if (c === quote)
            {
                break;
            }
        }
        out += cssText.slice(from, j);
        return j;
    };

    while (i < n)
    {
        const ch = cssText.charAt(i);

        if (ch === '"' || ch === '\'')
        {
            i = copyString(i);
            continue;
        }

        if (ch === '/' && cssText.charAt(i + 1) === '*')
        {
            const end = cssText.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            out += cssText.slice(i, stop);
            i = stop;
            continue;
        }

        // url( token (not the tail of a longer identifier): copy through the closing paren,
        // still honoring a quoted body so `url("a)b.png")` does not end early.
        if ((ch === 'u' || ch === 'U')
            && /^url\(/i.test(cssText.slice(i, i + 4))
            && !/[\w-]/.test(cssText.charAt(i - 1)))
        {
            out += cssText.slice(i, i + 4);
            i += 4;
            while (i < n && cssText.charAt(i) !== ')')
            {
                const inner = cssText.charAt(i);
                if (inner === '"' || inner === '\'')
                {
                    i = copyString(i);
                    continue;
                }
                out += inner;
                i++;
            }
            continue;
        }

        if (ch === '.')
        {
            CLASS_IDENT.lastIndex = i + 1;
            const match = CLASS_IDENT.exec(cssText);
            if (match !== null)
            {
                const name = match[0];
                const scoped = `${ name }_${ scope }`;
                classMap[name] = scoped;
                out += `.${ scoped }`;
                i += 1 + name.length;
                continue;
            }
        }

        out += ch;
        i++;
    }

    return out;
}

/**
 * THE RENDER-SAFETY POLICY - the markup a browser turns into EXECUTION or into a
 * page-wide retarget, judged by one set of predicates so no writer can drift from
 * another. Three consumers apply them to the same strings: the SSR serializer and the
 * DOM writer at runtime, and the compiler at build time over the values it FOLDS into a
 * clone template (a folded value reaches the document without passing any runtime
 * writer, so a policy stated only at runtime would not bind it).
 *
 * The predicates take plain strings. The `unsafeUrl`/`unsafeTag` opt-out markers are a
 * RUNTIME concept and stay in the renderer, which unwraps them before asking anything
 * here - so a marker can never be forged into this layer, and the compiler, which can
 * never meet one, does not need to know they exist.
 */

/**
 * Attributes the browser resolves as a URL and then FETCHES or NAVIGATES to. A scheme it
 * treats as code (`javascript:`, `vbscript:`) or as a document it will run script from
 * (`data:text/html`, `data:image/svg+xml`) turns a rendered value into execution - which is
 * what every "user-supplied link" injection reduces to. Names are matched lowercased, as
 * HTML attribute names are case-insensitive.
 */
export const URL_ATTRIBUTES: ReadonlySet<string> = new Set
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
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point: browsers remove them from a URL before resolving its scheme
const URL_CONTROL_CHARS = /[\x00-\x20]/g;

/** The scheme of a URL candidate, or no match for a relative URL. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** A `data:` URL carrying a non-SVG image, which is inert everywhere. */
const DATA_IMAGE_URL = /^data:image\/(?!svg)[a-z0-9.+-]+[;,]/i;

/** An `image/svg+xml` data URL, which is inert in an image context and scripted everywhere else. */
const DATA_SVG_URL = /^data:image\/svg\+xml[;,]/i;

/**
 * Tag+attribute pairs where the browser renders the URL as an IMAGE and nothing else. SVG
 * loaded there runs in the spec's secure static mode: no script, no external references, no
 * navigation - a guarantee every engine implements. Anywhere else (`<a href>`, `<iframe src>`,
 * a `<use xlink:href>`) an SVG document keeps its scripting, so the refusal stands there.
 */
const IMAGE_URL_CONTEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ['img', new Set(['src'])],
    ['video', new Set(['poster'])]
]);

/** Whether `tag[attribute]` is one of the image-only contexts above. */
export function rendersAsImage(tag: string | undefined, name: string): boolean
{
    return tag !== undefined && IMAGE_URL_CONTEXT.get(tag.toLowerCase())?.has(name) === true;
}

/**
 * Whether a URL hands the browser CODE rather than a resource, judged on the string the
 * browser would actually resolve.
 */
export function isExecutableUrl(value: string, imageContext = false): boolean
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
 * Tags refused outright: `<base>` rewrites where every relative URL on the page resolves to
 * (one injected tag re-points every link, form and script), and `<object>`/`<embed>` load a
 * document that runs script in this origin. `<iframe>` is deliberately NOT here - every video
 * and payment embed is one, and it is sandboxable and origin-isolated.
 */
export const REFUSED_TAGS: ReadonlySet<string> = new Set(['base', 'object', 'embed']);

/**
 * The `type` values a `<script>` can carry and still EXECUTE: the HTML JavaScript-MIME set,
 * plus `module` and the empty value (both mean "run this"). Any OTHER type is a data block the
 * browser never runs - `application/ld+json` is the documented case, and the SSR serializer has
 * dedicated escaping for its content.
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

/**
 * Whether a `<script>` carrying this RESOLVED type would run. An absent type means yes; a
 * caller that cannot resolve its type to a string must also treat it as yes, since a value
 * that cannot be proven inert must fail closed.
 */
export function scriptTypeExecutes(type: string | undefined): boolean
{
    if (type === undefined)
    {
        return true;
    }

    // A MIME's parameters (`;charset=utf-8`) do not change what it is.
    return JAVASCRIPT_MIME_TYPES.has(type.trim().toLowerCase().split(';')[0] ?? '');
}

/** The one rule text for a URL whose scheme the browser would execute. */
export function executableUrlMessage(key: string, written: string): string
{
    return `refusing ${ JSON.stringify(key) }=${ JSON.stringify(written) } - the browser would `
        + 'execute this URL rather than fetch it (javascript:/vbscript:, or a data: URL that is not an image - '
        + 'an SVG data URL is accepted only on <img src> and <video poster>, where it cannot script). '
        + 'Validate the value, or pass unsafeUrl(...) if it is deliberate.';
}

/** The one rule text for `srcdoc`, whose value is an inline document rather than a URL. */
export function srcdocMessage(key: string): string
{
    return `refusing the ${ JSON.stringify(key) } attribute - srcdoc is an inline DOCUMENT, `
        + 'so its value is markup that runs with the embedding page\'s privileges. Point the frame at a real URL, '
        + 'or pass unsafeUrl(...) if the content is yours.';
}

/** The one rule text for a tag that loads a document or retargets the page. */
export function refusedTagMessage(name: string): string
{
    return `refusing to render <${ name }> - it loads a document that runs script in this origin `
        + '(or, for <base>, silently re-targets every relative URL on the page). Use <iframe> for an embed, '
        + `or unsafeTag('${ name }') if it is deliberate.`;
}

/** The one rule text for a `<script>` whose type means the browser runs its content. */
export function executableScriptMessage(): string
{
    return 'refusing to render an executable <script> - its content would run with the page\'s '
        + 'privileges. A data block (type="application/ld+json" or any other non-JavaScript type) renders as-is; '
        + 'pass unsafeTag(\'script\') if the execution is deliberate.';
}

/**
 * Matches a string starting with a URL scheme (`https:`, `mailto:`, `tel:`, ...) or a
 * protocol-relative URL. Such targets are EXTERNAL: they leave the app's origin rather than
 * address a route within it.
 *
 * A BACKSLASH COUNTS AS A SLASH in the authority position, because that is what the URL
 * parser does: for a special scheme WHATWG folds `\` to `/`, so `/\host`, `\\host`, `\/host`
 * and `/\/host` all resolve to `host` exactly as `//host` does. Matching only on `//` left
 * every one of those spellings classified as an internal path while a browser navigated
 * off-origin - an open redirect through the boundary that exists to refuse them. Only the
 * leading PAIR is treated this way, so an ordinary path or query carrying a backslash
 * (`/search?q=a\b`) is untouched.
 */
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|[/\\]{2})/i;

/**
 * Whether a navigation target is EXTERNAL (scheme or protocol-relative), judged on the
 * string a browser would actually resolve: control characters and whitespace are stripped
 * before the scheme test, so the classifier and the rendered `href` can never disagree.
 *
 * Shared because more than the router needs it: the link's click logic, the router's
 * base-resolution, and the redirect boundaries that must refuse an app-derived target
 * pointing off-origin all answer to ONE definition of external.
 *
 * @example
 * ```ts
 * isExternalUrl('https://example.com'); // -> true
 * isExternalUrl('java\tscript:x');      // -> true (the browser sees a scheme; so do we)
 * isExternalUrl('/users/42');           // -> false (internal app path)
 * ```
 */
export function isExternalUrl(candidate: string): boolean
{
    return EXTERNAL_URL.test(candidate.replace(URL_CONTROL_CHARS, ''));
}

/**
 * The one rule text for a redirect whose target leaves the app's origin. A guard or loader
 * redirect is an AUTOMATIC navigation whose target is app-derived, so an off-origin one is
 * either a mistake or an attacker-supplied `?next=` reaching the wire - the open-redirect
 * shape. A deliberate one says so with `unsafeUrl(...)`.
 */
export function externalRedirectMessage(target: string): string
{
    return `refusing to redirect to ${ JSON.stringify(target) } - it leaves this app's origin, and a `
        + 'guard/loader redirect target is app-derived, so an off-origin one is the open-redirect shape. '
        + 'Redirect to a path, or wrap a deliberate off-origin target in unsafeUrl(...).';
}

/** ASCII whitespace, per the HTML spec's definition (not JS `\s`). */
const HTML_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f']);

/**
 * The URL a `<meta http-equiv="refresh">` directive would navigate to, or null when the
 * directive carries no target (a self-refresh, which navigates nowhere new) or is invalid
 * (in which case the browser performs no refresh at all).
 *
 * Implements HTML's shared declarative refresh steps, because a naive `url=` scan is wrong
 * in three ways the spec allows and an attacker uses: the `url=` prefix is OPTIONAL
 * (`0;https://evil.example/`), the separator may be `;`, `,` or bare whitespace, and the
 * target may be quoted. Anything that only looks for `url=` misses the majority of legal
 * spellings.
 */
export function refreshTarget(content: string): string | null
{
    let i = 0;
    const skipSpace = (): void =>
    {
        while (i < content.length && HTML_WHITESPACE.has(content[i] ?? ''))
        {
            i++;
        }
    };
    skipSpace();
    const isDigit = (at: number): boolean =>
    {
        const ch = content[at] ?? '';
        return ch >= '0' && ch <= '9';
    };
    // The time component: digits, optionally followed by a fraction the browser ignores.
    const timeStart = i;
    while (i < content.length && isDigit(i))
    {
        i++;
    }
    if (content[i] === '.')
    {
        while (i < content.length && (content[i] === '.' || isDigit(i)))
        {
            i++;
        }
    }
    if (i === timeStart && content[timeStart] !== '.')
    {
        return null;
    }
    if (i >= content.length)
    {
        return null;
    }
    // A separator is required here; anything else makes the whole directive invalid.
    const separator = content[i] ?? '';
    if (separator !== ';' && separator !== ',' && !HTML_WHITESPACE.has(separator))
    {
        return null;
    }
    skipSpace();
    if (content[i] === ';' || content[i] === ',')
    {
        i++;
        skipSpace();
    }
    if (i >= content.length)
    {
        return null;
    }
    // The `url=` prefix is optional: consume it when present, rewind entirely when not.
    const beforePrefix = i;
    if (content.slice(i, i + 3).toLowerCase() === 'url')
    {
        i += 3;
        skipSpace();
        if (content[i] === '=')
        {
            i++;
            skipSpace();
        }
        else
        {
            i = beforePrefix;
        }
    }
    let target = content.slice(i);
    const quote = target[0];
    if (quote === '"' || quote === '\'')
    {
        const end = target.indexOf(quote, 1);
        target = end === -1 ? target.slice(1) : target.slice(1, end);
    }
    return target.length === 0 ? null : target;
}
