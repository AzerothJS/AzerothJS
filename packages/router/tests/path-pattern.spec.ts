// @vitest-environment node
//
// Full behavioral coverage for compilePath (path-pattern.ts): the segment matcher
// (static, :param, trailing *wildcard, index), trailing-slash normalization,
// URL en/decoding rules, and the reverse build(). Pure logic - no DOM, real
// compiled matchers, deterministic.
import { describe, it, expect } from 'vitest';
import { compilePath } from '@azerothjs/router';

describe('compilePath — static segments', () =>
{
    it('matches an exact static path and extracts no params', () =>
    {
        const m = compilePath('/users');
        expect(m.match('/users')).toEqual({ params: {} });
    });

    it('rejects a path that differs in a static segment', () =>
    {
        const m = compilePath('/users');
        expect(m.match('/posts')).toBeNull();
    });

    it('rejects a longer path than the pattern', () =>
    {
        const m = compilePath('/users');
        expect(m.match('/users/42')).toBeNull();
    });

    it('rejects a shorter path than the pattern', () =>
    {
        const m = compilePath('/users/list');
        expect(m.match('/users')).toBeNull();
    });

    it('matches multi-segment static patterns', () =>
    {
        const m = compilePath('/a/b/c');
        expect(m.match('/a/b/c')).toEqual({ params: {} });
        expect(m.match('/a/b')).toBeNull();
        expect(m.match('/a/b/c/d')).toBeNull();
    });
});

describe('compilePath — index / empty pattern', () =>
{
    it('the empty pattern matches only "" and "/"', () =>
    {
        const m = compilePath('');
        expect(m.match('')).toEqual({ params: {} });
        expect(m.match('/')).toEqual({ params: {} });
        expect(m.match('/anything')).toBeNull();
    });

    it('the root pattern "/" matches "" and "/"', () =>
    {
        const m = compilePath('/');
        expect(m.match('/')).toEqual({ params: {} });
        expect(m.match('')).toEqual({ params: {} });
    });
});

describe('compilePath — trailing-slash normalization', () =>
{
    it('matches with or without a trailing slash', () =>
    {
        const m = compilePath('/users');
        expect(m.match('/users')).toEqual({ params: {} });
        expect(m.match('/users/')).toEqual({ params: {} });
    });

    it('normalizes the trailing slash for param patterns too', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.match('/users/42/')).toEqual({ params: { id: '42' } });
    });
});

describe('compilePath — param segments', () =>
{
    it('extracts a single param', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.match('/users/42')).toEqual({ params: { id: '42' } });
    });

    it('extracts multiple params keyed by name', () =>
    {
        const m = compilePath('/users/:id/posts/:slug');
        expect(m.match('/users/42/posts/hello')).toEqual({ params: { id: '42', slug: 'hello' } });
    });

    it('a param matches a non-empty segment but not a missing one', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.match('/users')).toBeNull();
    });

    it('param values are always strings (no numeric coercion)', () =>
    {
        const m = compilePath('/n/:value');
        const result = m.match('/n/007');
        expect(result).toEqual({ params: { value: '007' } });
        expect(typeof result!.params.value).toBe('string');
    });

    it('URL-decodes a param value', () =>
    {
        const m = compilePath('/users/:name');
        expect(m.match('/users/a%20b')).toEqual({ params: { name: 'a b' } });
    });

    it('decodes static segments on both sides before comparing', () =>
    {
        const m = compilePath('/a b/x');
        expect(m.match('/a%20b/x')).toEqual({ params: {} });
    });

    it('falls back to the raw value when a param is malformed %-escape', () =>
    {
        const m = compilePath('/users/:name');
        // %E0%A4%A is an invalid sequence; safeDecode returns it verbatim.
        expect(m.match('/users/%E0%A4%A')).toEqual({ params: { name: '%E0%A4%A' } });
    });
});

describe('compilePath — wildcard segments', () =>
{
    it('a trailing wildcard captures the remaining path joined by slashes', () =>
    {
        const m = compilePath('/docs/*path');
        expect(m.match('/docs/a/b/c')).toEqual({ params: { path: 'a/b/c' } });
    });

    it('a wildcard captures a single remaining segment', () =>
    {
        const m = compilePath('/docs/*path');
        expect(m.match('/docs/intro')).toEqual({ params: { path: 'intro' } });
    });

    it('a wildcard captures the empty string when nothing follows', () =>
    {
        const m = compilePath('/docs/*path');
        expect(m.match('/docs')).toEqual({ params: { path: '' } });
    });

    it('decodes each captured wildcard segment but keeps slashes', () =>
    {
        const m = compilePath('/files/*path');
        expect(m.match('/files/a%20b/c')).toEqual({ params: { path: 'a b/c' } });
    });

    it('a wildcard combines with preceding params', () =>
    {
        const m = compilePath('/u/:id/*rest');
        expect(m.match('/u/42/a/b')).toEqual({ params: { id: '42', rest: 'a/b' } });
    });

    it('throws at compile time when the wildcard is not last', () =>
    {
        expect(() => compilePath('/docs/*path/extra')).toThrow(/wildcard segment must be last/);
    });

    it('throws at compile time for an unnamed wildcard', () =>
    {
        expect(() => compilePath('/docs/*')).toThrow(/wildcard segment '\*' has no name/);
    });
});

describe('compilePath — invalid patterns', () =>
{
    it('throws for an unnamed param', () =>
    {
        expect(() => compilePath('/users/:')).toThrow(/param segment ':' has no name/);
    });

    it('throws for a duplicate parameter name (silent data loss otherwise)', () =>
    {
        expect(() => compilePath('/users/:id/:id')).toThrow(/duplicate parameter name ':id'/);
        expect(() => compilePath('/a/:x/b/*x')).toThrow(/duplicate parameter name ':x'/);
    });
});

describe('compilePath — build()', () =>
{
    it('substitutes a single param', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.build({ id: '42' })).toBe('/users/42');
    });

    it('substitutes multiple params', () =>
    {
        const m = compilePath('/users/:id/posts/:slug');
        expect(m.build({ id: '42', slug: 'hello' })).toBe('/users/42/posts/hello');
    });

    it('URL-encodes param values', () =>
    {
        const m = compilePath('/users/:name');
        expect(m.build({ name: 'a b' })).toBe('/users/a%20b');
    });

    it('does NOT encode slashes inside a wildcard value', () =>
    {
        const m = compilePath('/docs/*path');
        expect(m.build({ path: 'a/b/c' })).toBe('/docs/a/b/c');
    });

    it('ignores extra params not present in the pattern', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.build({ id: '42', extra: 'ignored' })).toBe('/users/42');
    });

    it('throws when a required param is missing', () =>
    {
        const m = compilePath('/users/:id');
        expect(() => m.build({})).toThrow(/missing required param 'id'/);
    });

    it('throws when a required wildcard is missing', () =>
    {
        const m = compilePath('/docs/*path');
        expect(() => m.build({})).toThrow(/missing required wildcard 'path'/);
    });

    it('builds the empty string for the index pattern', () =>
    {
        const m = compilePath('');
        expect(m.build({})).toBe('');
    });

    it('round-trips static + param patterns through build then match', () =>
    {
        const m = compilePath('/users/:id/posts/:slug');
        const built = m.build({ id: '42', slug: 'hello' });
        expect(m.match(built)).toEqual({ params: { id: '42', slug: 'hello' } });
    });
});

describe('compilePath — pattern metadata', () =>
{
    it('preserves the original pattern string', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.pattern).toBe('/users/:id');
    });

    it('a compiled matcher is reusable across many calls', () =>
    {
        const m = compilePath('/users/:id');
        expect(m.match('/users/1')).toEqual({ params: { id: '1' } });
        expect(m.match('/users/2')).toEqual({ params: { id: '2' } });
        expect(m.build({ id: '3' })).toBe('/users/3');
    });
});
