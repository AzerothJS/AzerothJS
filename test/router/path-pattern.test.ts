import { describe, it, expect } from 'vitest';
import { compilePath } from '../../packages/router/src/path-pattern.ts';

describe('compilePath().match()', () =>
{
    it('matches the empty/root pattern against the empty/root path only', () =>
    {
        const m = compilePath('');

        expect(m.match('')).toEqual({ params: {} });
        expect(m.match('/')).toEqual({ params: {} });
        expect(m.match('/foo')).toBeNull();
    });

    it('matches static paths with or without trailing slash', () =>
    {
        const m = compilePath('/users');

        expect(m.match('/users')).toEqual({ params: {} });
        expect(m.match('/users/')).toEqual({ params: {} });
    });

    it('returns null when the static path does not match', () =>
    {
        const m = compilePath('/users');

        expect(m.match('/posts')).toBeNull();
        expect(m.match('/users/42')).toBeNull();
        expect(m.match('/')).toBeNull();
    });

    it('captures a single param', () =>
    {
        const m = compilePath('/users/:id');

        expect(m.match('/users/42')).toEqual({ params: { id: '42' } });
        expect(m.match('/users')).toBeNull();      // missing param
        expect(m.match('/users/42/extra')).toBeNull(); // overflow
    });

    it('captures multiple params independently', () =>
    {
        const m = compilePath('/users/:id/posts/:slug');

        expect(m.match('/users/42/posts/hello-world')).toEqual({
            params: { id: '42', slug: 'hello-world' }
        });
    });

    it('URL-decodes captured param values', () =>
    {
        const m = compilePath('/users/:name');

        expect(m.match('/users/John%20Doe')).toEqual({
            params: { name: 'John Doe' }
        });
    });

    it('wildcard captures the rest of the path with slashes preserved', () =>
    {
        const m = compilePath('/docs/*path');

        expect(m.match('/docs/intro/install')).toEqual({
            params: { path: 'intro/install' }
        });
        expect(m.match('/docs/single')).toEqual({
            params: { path: 'single' }
        });
        // Wildcard accepts an empty tail too.
        expect(m.match('/docs')).toEqual({
            params: { path: '' }
        });
    });

    it('wildcard alone captures the whole path without leading slash', () =>
    {
        const m = compilePath('/*all');

        expect(m.match('/anything/here/now')).toEqual({
            params: { all: 'anything/here/now' }
        });
        expect(m.match('/')).toEqual({
            params: { all: '' }
        });
    });
});

describe('compilePath().build()', () =>
{
    it('substitutes params and URL-encodes their values', () =>
    {
        const m = compilePath('/users/:id/posts/:slug');

        expect(m.build({ id: '42', slug: 'hello world' }))
            .toBe('/users/42/posts/hello%20world');
    });

    it('throws when a required param is missing', () =>
    {
        const m = compilePath('/users/:id');

        expect(() => m.build({})).toThrow(/missing required param 'id'/);
    });

    it('ignores extra keys in the params object', () =>
    {
        const m = compilePath('/users/:id');

        expect(m.build({ id: '42', extra: 'ignored' })).toBe('/users/42');
    });

    it('inserts wildcard values verbatim (no slash double-encoding)', () =>
    {
        const m = compilePath('/docs/*path');

        expect(m.build({ path: 'intro/install' })).toBe('/docs/intro/install');
    });
});

describe('compilePath() parser errors', () =>
{
    it('throws on a nameless param or wildcard segment', () =>
    {
        expect(() => compilePath('/users/:')).toThrow(/param segment ':' has no name/);
        expect(() => compilePath('/files/*')).toThrow(/wildcard segment '\*' has no name/);
    });

    it('throws when a wildcard is not the last segment', () =>
    {
        expect(() => compilePath('/a/*x/b')).toThrow(/wildcard segment must be last/);
    });
});
