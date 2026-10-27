// @vitest-environment node
//
// The shared language vocabulary's own invariants. Every backend consumes these facts, so
// the facts themselves carry the contracts: classifier round-trips, the delegated set being
// a subset of the documented vocabulary, and the name-domain boundaries.
import { describe, it, expect } from 'vitest';
import {
    hostEventType,
    isReservedHostAttribute,
    isEventNamespace,
    canonicalHandlerName,
    reservedHostAttributeMessage,
    bindWriteBack,
    CONTENT_PROPERTIES,
    DOM_PROPERTIES,
    VOID_ELEMENTS,
    contentModel,
    leadingNewlinePad,
    escapeCarriageReturns,
    normalizeLineBreaks,
    textValue,
    isTextValueProperty,
    isChildResolvedProperty,
    DELEGATED_EVENTS,
    isDelegatedEvent,
    EVENT_HANDLER_NAMES,
    BUILTIN_COMPONENTS,
    BUILTIN_SET,
    isComponentTag,
    isFactoryProp,
    isBindingAttr
} from 'azerothjs/semantics';

describe('hostEventType - the one handler classifier', () =>
{
    it('classifies handler-form names to their lowercase event type', () =>
    {
        expect(hostEventType('onClick')).toBe('click');
        expect(hostEventType('onMouseDown')).toBe('mousedown');
        expect(hostEventType('onDblClick')).toBe('dblclick');
    });

    it('returns null for everything outside handler form', () =>
    {
        expect(hostEventType('onclick')).toBeNull();
        expect(hostEventType('online')).toBeNull();
        expect(hostEventType('on')).toBeNull();
        expect(hostEventType('ONCLICK')).toBeNull();
        expect(hostEventType('title')).toBeNull();
    });

    it('round-trips through canonicalHandlerName for every lowercase type', () =>
    {
        for (const type of ['click', 'dblclick', 'paste', 'pointercancel', 'x'])
        {
            expect(hostEventType(canonicalHandlerName(type))).toBe(type);
        }
    });
});

describe('the reserved namespace', () =>
{
    it('is exactly the on* family minus handler form', () =>
    {
        for (const name of ['onclick', 'once', 'ONCLICK', 'oNcLiCk', 'onward-link', 'on'])
        {
            expect(isEventNamespace(name)).toBe(true);
            expect(isReservedHostAttribute(name)).toBe(true);
        }
        for (const name of ['onClick', 'on-retry', 'onX'])
        {
            expect(isEventNamespace(name)).toBe(true);
            expect(isReservedHostAttribute(name)).toBe(false);
        }
        expect(isEventNamespace('title')).toBe(false);
        expect(isReservedHostAttribute('title')).toBe(false);
    });

    it('the rule text carries the mechanical camelCase repair when one exists', () =>
    {
        expect(reservedHostAttributeMessage('onpaste')).toContain('onPaste');
        expect(reservedHostAttributeMessage('ONCLICK')).toContain('onClick');
        expect(reservedHostAttributeMessage('on')).toContain('data-');
    });
});

describe('the delegated set is part of the documented vocabulary', () =>
{
    it('every delegated type has a canonical handler name in EVENT_HANDLER_NAMES', () =>
    {
        const knownTypes = new Set(EVENT_HANDLER_NAMES.map((name) => hostEventType(name)));
        for (const type of DELEGATED_EVENTS)
        {
            expect(knownTypes.has(type)).toBe(true);
        }
    });

    it('every documented handler name IS handler-form', () =>
    {
        for (const name of EVENT_HANDLER_NAMES)
        {
            expect(hostEventType(name)).not.toBeNull();
        }
    });

    it('isDelegatedEvent mirrors the set', () =>
    {
        expect(isDelegatedEvent('click')).toBe(true);
        expect(isDelegatedEvent('focus')).toBe(false);
        expect(isDelegatedEvent('scroll')).toBe(false);
    });
});

describe('write-back, content, and property facts', () =>
{
    it('checked writes back on change; everything else on input', () =>
    {
        expect(bindWriteBack('checked')).toEqual({ event: 'change', callback: 'onChange' });
        expect(bindWriteBack('value')).toEqual({ event: 'input', callback: 'onInput' });
    });

    it('content properties are a subset of the DOM property set', () =>
    {
        for (const prop of CONTENT_PROPERTIES)
        {
            expect(DOM_PROPERTIES.has(prop)).toBe(true);
        }
    });

    it('the void set carries the HTML table', () =>
    {
        expect(VOID_ELEMENTS.has('input')).toBe(true);
        expect(VOID_ELEMENTS.has('div')).toBe(false);
    });

    it('one content-model table names how the parser reads each element, in any case', () =>
    {
        expect(['script', 'style'].map(contentModel)).toEqual(['raw-text', 'raw-text']);
        expect(['textarea', 'title'].map(contentModel)).toEqual(['escapable-raw-text', 'escapable-raw-text']);
        expect(['iframe', 'noembed', 'noframes', 'xmp'].map(contentModel))
            .toEqual(['raw-text-parsed', 'raw-text-parsed', 'raw-text-parsed', 'raw-text-parsed']);
        expect(contentModel('noscript')).toBe('server-only');
        expect(['TEXTAREA', 'textArea', 'tiTle', 'sTyle', 'noScript', 'xMp'].map(contentModel))
            .toEqual(['escapable-raw-text', 'escapable-raw-text', 'escapable-raw-text', 'raw-text', 'server-only', 'raw-text-parsed']);
        expect(['div', 'textPath', 'pre'].map(contentModel)).toEqual([null, null, null]);
    });

    it('a textarea value is its text, disjoint from the select rule', () =>
    {
        expect(isTextValueProperty('value', 'textarea')).toBe(true);
        expect(isTextValueProperty('value', 'textArea')).toBe(true);
        expect(isTextValueProperty('value', 'input')).toBe(false);
        expect(isTextValueProperty('defaultValue', 'textarea')).toBe(false);
        expect(isChildResolvedProperty('value', 'select')).toBe(true);
        for (const tag of ['textarea', 'select', 'input', 'option'])
        {
            expect(isTextValueProperty('value', tag) && isChildResolvedProperty('value', tag)).toBe(false);
        }
    });

    it('textValue is the value property\'s own coercion', () =>
    {
        expect([null, undefined, false, 0, 'x', ['a', 'b']].map(textValue)).toEqual(['', 'undefined', 'false', '0', 'x', 'a,b']);
    });

    it('leadingNewlinePad answers content that starts with LF, CR or a reference, after <textarea> only', () =>
    {
        expect(['\nx', '\rx', '&#10;x', '&amp;'].map((html) => leadingNewlinePad('textarea', html))).toEqual(['\n', '\n', '\n', '\n']);
        expect(leadingNewlinePad('textArea', '\nx')).toBe('\n');
        expect(['x', ' \n', ''].map((html) => leadingNewlinePad('textarea', html))).toEqual(['', '', '']);
        expect(leadingNewlinePad('title', '\nx')).toBe('');
        expect(leadingNewlinePad('pre', '\nx')).toBe('');
    });

    it('escapeCarriageReturns writes each CR as a reference and leaves line feeds, so a leading CR gets the pad', () =>
    {
        expect(['a\rb', 'a\r\nb', '\r\r', 'a\nb', ''].map(escapeCarriageReturns)).toEqual(['a&#13;b', 'a&#13;\nb', '&#13;&#13;', 'a\nb', '']);
        expect(leadingNewlinePad('textarea', escapeCarriageReturns('\rx'))).toBe('\n');
    });

    it('normalizeLineBreaks reads each CRLF and each lone CR as LF and leaves everything else', () =>
    {
        expect(['a\r\nb', 'a\rb', '\r\r\n', '\n\r', 'a\nb', 'a&#13;b', ''].map(normalizeLineBreaks))
            .toEqual(['a\nb', 'a\nb', '\n\n', '\n\n', 'a\nb', 'a&#13;b', '']);
    });
});

describe('tag domain and builtins', () =>
{
    it('capitalized or dotted tags are components; the rest are hosts', () =>
    {
        expect(isComponentTag('Show')).toBe(true);
        expect(isComponentTag('Foo.Bar')).toBe(true);
        expect(isComponentTag('div')).toBe(false);
        expect(isComponentTag('my-widget')).toBe(false);
    });

    it('classifies the edges an inline copy gets wrong', () =>
    {
        // Every re-implementation of this rule found in the tree tested `/^[A-Z]/` or
        // its `/^[a-z]/` inverse, which answer differently from the owner on a tag that
        // starts with neither. Pinned here so the next copy fails a test instead of
        // splitting hover, navigation and the parser three ways.
        expect(isComponentTag('')).toBe(false);
        expect(isComponentTag('_private')).toBe(false);
        expect(isComponentTag('9lives')).toBe(false);
        // A dotted tag is a component whatever its first character.
        expect(isComponentTag('ns.widget')).toBe(true);
    });

    it('the builtin list and its Set form agree, with no duplicates', () =>
    {
        expect(BUILTIN_SET.size).toBe(BUILTIN_COMPONENTS.length);
        for (const tag of ['Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic', 'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'])
        {
            expect(BUILTIN_SET.has(tag)).toBe(true);
        }
        expect(BUILTIN_SET.has('Counter')).toBe(false);
    });

    it('factory props belong to the component contract, not the prop name', () =>
    {
        expect(isFactoryProp('Show', 'fallback')).toBe(true);
        expect(isFactoryProp('Dynamic', 'component')).toBe(true);
        expect(isFactoryProp('Routes', 'fallback')).toBe(true);
        expect(isFactoryProp('Card', 'fallback')).toBe(false);
    });

    it('binding attrs belong to the component contract, not the attribute name', () =>
    {
        expect(isBindingAttr('Show', 'let')).toBe(true);
        expect(isBindingAttr('Match', 'let')).toBe(true);
        expect(isBindingAttr('For', 'let')).toBe(true);
        expect(isBindingAttr('For', 'index')).toBe(true);

        // `index` narrows nothing outside a row, and a user component's `let` is a prop.
        expect(isBindingAttr('Show', 'index')).toBe(false);
        expect(isBindingAttr('Transition', 'let')).toBe(false);
        expect(isBindingAttr('Card', 'let')).toBe(false);
    });
});
