import { describe, it, expect } from 'vitest';
import { parseQuery, stringifyQuery } from '../../packages/router/src/query.ts';

describe('parseQuery', () =>
{
    it('accepts a leading ? or a bare query string interchangeably', () =>
    {
        expect(parseQuery('?page=2')).toEqual({ page: '2' });
        expect(parseQuery('page=2')).toEqual({ page: '2' });
    });

    it('returns an empty object for empty input', () =>
    {
        expect(parseQuery('')).toEqual({});
        expect(parseQuery('?')).toEqual({});
    });

    it('parses scalar values as strings', () =>
    {
        expect(parseQuery('?page=2&sort=desc')).toEqual({
            page: '2',
            sort: 'desc'
        });
    });

    it('coalesces repeated keys into an array', () =>
    {
        expect(parseQuery('?tags=a&tags=b')).toEqual({
            tags: ['a', 'b']
        });
    });

    it('preserves insertion order across three or more occurrences', () =>
    {
        expect(parseQuery('?x=1&x=2&x=3')).toEqual({
            x: ['1', '2', '3']
        });
    });

    it('represents no-value and empty-value keys as empty strings', () =>
    {
        expect(parseQuery('?flag')).toEqual({ flag: '' });
        expect(parseQuery('?flag=')).toEqual({ flag: '' });
    });

    it('URL-decodes values, accepting both %20 and + for spaces', () =>
    {
        expect(parseQuery('?name=John%20Doe')).toEqual({ name: 'John Doe' });
        expect(parseQuery('?name=John+Doe')).toEqual({ name: 'John Doe' });
        expect(parseQuery('?q=a%26b')).toEqual({ q: 'a&b' });
    });
});

describe('stringifyQuery', () =>
{
    it('serializes scalar values to flat key=value pairs', () =>
    {
        expect(stringifyQuery({ page: '2', sort: 'desc' }))
            .toBe('page=2&sort=desc');
    });

    it('serializes array values as repeated keys', () =>
    {
        expect(stringifyQuery({ tags: ['a', 'b'] }))
            .toBe('tags=a&tags=b');
    });

    it('serializes a mix of scalars and arrays in object insertion order', () =>
    {
        expect(stringifyQuery({ page: '2', tags: ['a', 'b'] }))
            .toBe('page=2&tags=a&tags=b');
    });

    it('returns empty string for empty input or empty arrays', () =>
    {
        expect(stringifyQuery({})).toBe('');
        // Empty-array values produce no output — the key is dropped.
        expect(stringifyQuery({ tags: [] })).toBe('');
    });

    it('URL-encodes values', () =>
    {
        // URLSearchParams encodes spaces as '+' (form-encoded style)
        // and percent-encodes other reserved characters.
        expect(stringifyQuery({ q: 'hello world' })).toBe('q=hello+world');
        expect(stringifyQuery({ q: 'a&b' })).toBe('q=a%26b');
    });
});

describe('parseQuery / stringifyQuery round-trip', () =>
{
    it('preserves a representative mixed-shape value', () =>
    {
        const original: Record<string, string | string[]> = {
            page: '2',
            sort: 'desc',
            tags: ['a', 'b', 'c'],
            q: 'hello world',
            flag: ''
        };

        const round = parseQuery(stringifyQuery(original));
        expect(round).toEqual(original);
    });
});
