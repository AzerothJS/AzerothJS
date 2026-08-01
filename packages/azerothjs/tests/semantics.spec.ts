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
    RAW_TEXT_ELEMENTS,
    DELEGATED_EVENTS,
    isDelegatedEvent,
    EVENT_HANDLER_NAMES,
    BUILTIN_COMPONENTS,
    BUILTIN_SET,
    isComponentTag,
    isFactoryProp
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

    it('void and raw-text sets carry the HTML tables', () =>
    {
        expect(VOID_ELEMENTS.has('input')).toBe(true);
        expect(VOID_ELEMENTS.has('div')).toBe(false);
        expect(RAW_TEXT_ELEMENTS.has('script')).toBe(true);
        expect(RAW_TEXT_ELEMENTS.has('style')).toBe(true);
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
});
