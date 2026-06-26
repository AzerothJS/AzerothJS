// @vitest-environment node
//
// Full behavioral coverage for parseQuery / stringifyQuery (query.ts): the
// string<->Query shape (single -> string, repeated -> string[], no-value -> ''),
// leading-`?` tolerance, encoding via URLSearchParams, and round-tripping. Pure
// logic - no DOM, deterministic.
import { describe, it, expect } from 'vitest';
import { parseQuery, stringifyQuery } from '@azerothjs/router';

describe('parseQuery', () =>
{
    it('returns {} for an empty string', () =>
    {
        expect(parseQuery('')).toEqual({});
    });

    it('returns {} for a lone "?"', () =>
    {
        expect(parseQuery('?')).toEqual({});
    });

    it('parses a single key=value pair', () =>
    {
        expect(parseQuery('page=2')).toEqual({ page: '2' });
    });

    it('tolerates a leading "?"', () =>
    {
        expect(parseQuery('?page=2&sort=desc')).toEqual({ page: '2', sort: 'desc' });
    });

    it('parses multiple distinct keys', () =>
    {
        expect(parseQuery('a=1&b=2&c=3')).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('collapses a repeated key into an array preserving order', () =>
    {
        expect(parseQuery('?a=1&a=2')).toEqual({ a: ['1', '2'] });
    });

    it('collapses three occurrences into a three-element array', () =>
    {
        expect(parseQuery('tags=a&tags=b&tags=c')).toEqual({ tags: ['a', 'b', 'c'] });
    });

    it('a single occurrence stays a string, not a one-element array', () =>
    {
        const result = parseQuery('tags=a');
        expect(result).toEqual({ tags: 'a' });
        expect(Array.isArray(result.tags)).toBe(false);
    });

    it('a value-less flag becomes an empty string', () =>
    {
        expect(parseQuery('?flag')).toEqual({ flag: '' });
    });

    it('an explicit empty value also becomes an empty string', () =>
    {
        expect(parseQuery('?flag=')).toEqual({ flag: '' });
    });

    it('URL-decodes keys and values', () =>
    {
        expect(parseQuery('q=a%20b')).toEqual({ q: 'a b' });
    });

    it('decodes "+" as a space (URLSearchParams semantics)', () =>
    {
        expect(parseQuery('q=a+b')).toEqual({ q: 'a b' });
    });

    it('preserves the first-appearance order of distinct keys', () =>
    {
        const result = parseQuery('z=1&a=2&m=3');
        expect(Object.keys(result)).toEqual(['z', 'a', 'm']);
    });

    it('groups repeated keys by first appearance even when interleaved', () =>
    {
        const result = parseQuery('a=1&b=2&a=3');
        expect(result).toEqual({ a: ['1', '3'], b: '2' });
        expect(Object.keys(result)).toEqual(['a', 'b']);
    });
});

describe('stringifyQuery', () =>
{
    it('returns "" for an empty object', () =>
    {
        expect(stringifyQuery({})).toBe('');
    });

    it('serializes a single string value', () =>
    {
        expect(stringifyQuery({ page: '2' })).toBe('page=2');
    });

    it('serializes multiple keys joined by "&"', () =>
    {
        expect(stringifyQuery({ page: '2', sort: 'desc' })).toBe('page=2&sort=desc');
    });

    it('serializes an array value to repeated keys', () =>
    {
        expect(stringifyQuery({ tags: ['a', 'b'] })).toBe('tags=a&tags=b');
    });

    it('omits a key whose value is an empty array', () =>
    {
        expect(stringifyQuery({ tags: [], page: '1' })).toBe('page=1');
    });

    it('emits no leading "?"', () =>
    {
        expect(stringifyQuery({ a: '1' }).startsWith('?')).toBe(false);
    });

    it('encodes spaces as "+" (URLSearchParams)', () =>
    {
        expect(stringifyQuery({ q: 'a b' })).toBe('q=a+b');
    });

    it('serializes an empty-string value as a bare key=', () =>
    {
        expect(stringifyQuery({ flag: '' })).toBe('flag=');
    });
});

describe('parseQuery <-> stringifyQuery round trips', () =>
{
    it('round-trips a multi-key query', () =>
    {
        const original = { page: '2', sort: 'desc' };
        expect(parseQuery(stringifyQuery(original))).toEqual(original);
    });

    it('round-trips an array (repeated key) query', () =>
    {
        const original = { tags: ['a', 'b', 'c'] };
        expect(parseQuery(stringifyQuery(original))).toEqual(original);
    });

    it('round-trips a value with special characters', () =>
    {
        const original = { q: 'a b&c=d' };
        expect(parseQuery(stringifyQuery(original))).toEqual(original);
    });

    it('round-trips a mix of single and repeated keys', () =>
    {
        const original = { a: '1', b: ['2', '3'] };
        expect(parseQuery(stringifyQuery(original))).toEqual(original);
    });

    it('stringify then parse drops an empty-array key (it had no representation)', () =>
    {
        expect(parseQuery(stringifyQuery({ tags: [], page: '1' }))).toEqual({ page: '1' });
    });
});
