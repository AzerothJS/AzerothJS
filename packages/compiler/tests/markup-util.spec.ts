// @vitest-environment node
//
// Real-execution coverage for markup-util: the wrapDynamic reactivity-shape
// heuristic, quoteString/objectKey escaping, isEventName, and walkComponentTags.
import { describe, it, expect } from 'vitest';
import { walkComponentTags } from '@azerothjs/compiler';
import { wrapDynamic, quoteString, objectKey, isEventName } from '../src/markup-util.ts';
import { parseMarkup } from '@azerothjs/compiler';
import type { MarkupElement, MarkupFragment } from '@azerothjs/compiler';

describe('wrapDynamic', () =>
{
    it('wraps a computed expression in a getter thunk', () =>
    {
        expect(wrapDynamic('a + b', false)).toBe('() => (a + b)');
    });

    it('leaves a bare reference or dotted path verbatim', () =>
    {
        expect(wrapDynamic('count', false)).toBe('count');
        expect(wrapDynamic('props.value', false)).toBe('props.value');
    });

    it('leaves a function literal verbatim', () =>
    {
        expect(wrapDynamic('(item) => item.name', false)).toBe('(item) => item.name');
        expect(wrapDynamic('function () {}', false)).toBe('function () {}');
    });

    it('leaves an array/object literal verbatim', () =>
    {
        expect(wrapDynamic('[res]', false)).toBe('[res]');
        expect(wrapDynamic('{ a: 1 }', false)).toBe('{ a: 1 }');
    });

    it('passes any event-handler expression through verbatim', () =>
    {
        expect(wrapDynamic('save()', true)).toBe('save()');
        expect(wrapDynamic('a + b', true)).toBe('a + b');
    });

    it('trims surrounding whitespace before classifying', () =>
    {
        expect(wrapDynamic('  count  ', false)).toBe('count');
        expect(wrapDynamic('  a + b  ', false)).toBe('() => (a + b)');
    });
});

describe('quoteString', () =>
{
    it('wraps in single quotes and escapes inner quotes, backslashes, newlines', () =>
    {
        expect(quoteString('hi')).toBe('\'hi\'');
        expect(quoteString('a\'b')).toBe('\'a\\\'b\'');
        expect(quoteString('a\\b')).toBe('\'a\\\\b\'');
        expect(quoteString('a\nb')).toBe('\'a\\nb\'');
    });
});

describe('objectKey', () =>
{
    it('emits a bare identifier unquoted and a non-identifier quoted', () =>
    {
        expect(objectKey('class')).toBe('class');
        expect(objectKey('$ref')).toBe('$ref');
        expect(objectKey('data-id')).toBe('\'data-id\'');
        expect(objectKey('aria-label')).toBe('\'aria-label\'');
    });
});

describe('isEventName', () =>
{
    it('is true for on + uppercase letter', () =>
    {
        expect(isEventName('onClick')).toBe(true);
        expect(isEventName('onMouseDown')).toBe(true);
    });

    it('is false when the third char is not uppercase or it is too short', () =>
    {
        expect(isEventName('online')).toBe(false);
        expect(isEventName('on')).toBe(false);
        expect(isEventName('onclick')).toBe(false);
    });
});

describe('walkComponentTags', () =>
{
    function tags(src: string): string[]
    {
        const { node } = parseMarkup(src, 0);
        const out: string[] = [];
        walkComponentTags(node as MarkupElement | MarkupFragment, (t) => out.push(t));
        return out;
    }

    it('visits component tags and skips host elements', () =>
    {
        expect(tags('<Show><p>hi</p></Show>')).toEqual(['Show']);
    });

    it('visits nested and dotted component tags in source order', () =>
    {
        expect(tags('<div><For><Foo.Bar/></For></div>')).toEqual(['For', 'Foo.Bar']);
    });

    it('does not descend into expression holes', () =>
    {
        // The <Inner/> lives inside a hole, not the element tree, so it is skipped.
        expect(tags('<div>{cond ? <Inner/> : null}</div>')).toEqual([]);
    });

    it('returns nothing for a host-only tree', () =>
    {
        expect(tags('<ul><li>a</li></ul>')).toEqual([]);
    });
});
