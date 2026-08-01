/**
 * MODULE: semantics - the language's shared vocabulary
 *
 * The single owner of every markup fact that more than one implementation consumes: the
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
 * Attribute names written as live DOM properties on the client. Their server
 * representation is the matching attribute (`value="x"`), which the browser parses back
 * into the property, so the two writers agree; `innerHTML`/`textContent` additionally own
 * the element's content (see {@link CONTENT_PROPERTIES}).
 */
export const DOM_PROPERTIES: ReadonlySet<string> = new Set([
    'value', 'checked', 'selected', 'disabled', 'innerHTML', 'textContent'
]);

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
