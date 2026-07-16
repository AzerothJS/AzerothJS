// @vitest-environment node
//
// The radix router is the kernel's most load-bearing structure: every request crosses it, and
// its conflict rules are what make silently-shadowed routes (an Express hallmark) impossible.
// These tests pin the matching semantics exhaustively - precedence, backtracking, decoding,
// method mismatch vs miss - and every conflict rule's exact failure.

import { describe, it, expect, expectTypeOf } from 'vitest';
import { RadixRouter, type PathParams } from '../src/router.ts';

function build(routes: Array<[string, string]>): RadixRouter<string>
{
    const router = new RadixRouter<string>();
    for (const [method, pattern] of routes)
    {
        router.insert(method, pattern, `${ method } ${ pattern }`);
    }
    return router;
}

describe('matching: statics, params, wildcards', () =>
{
    it('matches a static route exactly', () =>
    {
        const router = build([['GET', '/health']]);
        const result = router.match('GET', '/health');
        expect(result).toEqual({ kind: 'match', value: 'GET /health', params: {} });
    });

    it('matches the root path', () =>
    {
        const router = build([['GET', '/']]);
        expect(router.match('GET', '/').kind).toBe('match');
        expect(router.match('GET', '').kind).toBe('match');
    });

    it('captures a named parameter', () =>
    {
        const router = build([['GET', '/users/:id']]);
        const result = router.match('GET', '/users/42');
        expect(result).toEqual({ kind: 'match', value: 'GET /users/:id', params: { id: '42' } });
    });

    it('captures multiple parameters across segments', () =>
    {
        const router = build([['GET', '/orgs/:org/repos/:repo']]);
        const result = router.match('GET', '/orgs/azeroth/repos/http');
        expect(result.kind === 'match' && result.params).toEqual({ org: 'azeroth', repo: 'http' });
    });

    it('prefers a static segment over a parameter at the same position', () =>
    {
        const router = build([['GET', '/users/me'], ['GET', '/users/:id']]);
        expect(router.match('GET', '/users/me').kind === 'match'
            && (router.match('GET', '/users/me') as { value: string }).value).toBe('GET /users/me');
        expect((router.match('GET', '/users/7') as { value: string }).value).toBe('GET /users/:id');
    });

    it('backtracks: a static dead-end falls back to the param branch', () =>
    {
        // `/users/me` exists but has no `/settings` child; `/users/:id/settings` must win.
        const router = build([['GET', '/users/me'], ['GET', '/users/:id/settings']]);
        const result = router.match('GET', '/users/me/settings');
        expect(result).toEqual({
            kind: 'match',
            value: 'GET /users/:id/settings',
            params: { id: 'me' }
        });
    });

    it('a wildcard captures the joined remainder', () =>
    {
        const router = build([['GET', '/files/*path']]);
        const result = router.match('GET', '/files/a/b/c.txt');
        expect(result.kind === 'match' && result.params).toEqual({ path: 'a/b/c.txt' });
    });

    it('a wildcard requires at least one segment (documented find-my-way semantics)', () =>
    {
        const router = build([['GET', '/files/*path']]);
        expect(router.match('GET', '/files').kind).toBe('miss');
    });

    it('a wildcard loses to both static and param branches', () =>
    {
        const router = build([['GET', '/f/*rest'], ['GET', '/f/:one'], ['GET', '/f/two']]);
        expect((router.match('GET', '/f/two') as { value: string }).value).toBe('GET /f/two');
        expect((router.match('GET', '/f/one') as { value: string }).value).toBe('GET /f/:one');
        expect((router.match('GET', '/f/a/b') as { value: string }).value).toBe('GET /f/*rest');
    });

    it('failed param branches do not leak captures into the winning branch', () =>
    {
        // The param branch captures {id: 'x'} then dead-ends; the wildcard result must not carry `id`.
        const router = build([['GET', '/a/:id/end'], ['GET', '/a/*rest']]);
        const result = router.match('GET', '/a/x/other');
        expect(result.kind === 'match' && result.params).toEqual({ rest: 'x/other' });
    });
});

describe('path normalization and decoding', () =>
{
    it('collapses duplicate slashes and one trailing slash', () =>
    {
        const router = build([['GET', '/a/b']]);
        expect(router.match('GET', '/a/b/').kind).toBe('match');
        expect(router.match('GET', '//a//b').kind).toBe('match');
    });

    it('percent-decodes each segment', () =>
    {
        const router = build([['GET', '/tags/:tag']]);
        const result = router.match('GET', '/tags/caf%C3%A9%20au%20lait');
        expect(result.kind === 'match' && result.params).toEqual({ tag: 'café au lait' });
    });

    it('an encoded slash stays INSIDE its segment (no path-structure smuggling)', () =>
    {
        // %2F decodes to '/', but decoding happens per segment AFTER splitting, so the
        // decoded slash cannot create a new segment - the classic traversal-bypass stays shut.
        const router = build([['GET', '/one/:a'], ['GET', '/one/x/y']]);
        const result = router.match('GET', '/one/x%2Fy');
        expect(result).toEqual({ kind: 'match', value: 'GET /one/:a', params: { a: 'x/y' } });
    });

    it('a malformed percent-escape is a miss, never a throw', () =>
    {
        const router = build([['GET', '/x/:v']]);
        expect(router.match('GET', '/x/%ZZ').kind).toBe('miss');
    });
});

describe('methods: mismatch vs miss, HEAD fallback', () =>
{
    it('distinguishes method-mismatch (405 + Allow) from a miss (404)', () =>
    {
        const router = build([['GET', '/thing'], ['PUT', '/thing']]);
        expect(router.match('DELETE', '/thing')).toEqual({ kind: 'method-mismatch', allowed: ['GET', 'PUT'] });
        expect(router.match('DELETE', '/absent')).toEqual({ kind: 'miss' });
    });

    it('HEAD falls back to the GET registration', () =>
    {
        const router = build([['GET', '/doc']]);
        expect((router.match('HEAD', '/doc') as { value: string }).value).toBe('GET /doc');
    });

    it('an explicit HEAD registration wins over the GET fallback', () =>
    {
        const router = build([['GET', '/doc'], ['HEAD', '/doc']]);
        expect((router.match('HEAD', '/doc') as { value: string }).value).toBe('HEAD /doc');
    });

    it('method names are case-insensitive on both sides', () =>
    {
        const router = build([['get', '/x']]);
        expect(router.match('GET', '/x').kind).toBe('match');
    });
});

describe('conflict detection fails registration loudly', () =>
{
    it('rejects a duplicate (method, pattern)', () =>
    {
        expect(() => build([['GET', '/a'], ['GET', '/a']])).toThrow(/already registered/);
    });

    it('allows the same pattern under different methods', () =>
    {
        expect(() => build([['GET', '/a'], ['POST', '/a']])).not.toThrow();
    });

    it('rejects two different param names at one position', () =>
    {
        expect(() => build([['GET', '/u/:id'], ['GET', '/u/:name/x']])).toThrow(/:id/);
    });

    it('rejects two different wildcard names at one position', () =>
    {
        expect(() => build([['GET', '/f/*a'], ['POST', '/f/*b']])).toThrow(/\*a/);
    });

    it('rejects a non-terminal wildcard', () =>
    {
        expect(() => build([['GET', '/f/*rest/tail']])).toThrow(/final segment/);
    });

    it('rejects nameless params and wildcards', () =>
    {
        expect(() => build([['GET', '/x/:']])).toThrow(/needs a name/);
        expect(() => build([['GET', '/x/*']])).toThrow(/needs a name/);
    });

    it('normalized-equal patterns conflict even when spelled differently', () =>
    {
        expect(() => build([['GET', '/a/b'], ['GET', '/a/b/']])).toThrow(/already registered/);
    });
});

describe('the printable route table', () =>
{
    it('lists every registration in order', () =>
    {
        const router = build([['GET', '/a'], ['POST', '/b/:id'], ['GET', '/c/*rest']]);
        const table = router.table();
        expect(table).toHaveLength(3);
        expect(table[0]).toContain('GET');
        expect(table[0]).toContain('/a');
        expect(table[1]).toContain('POST');
        expect(table[1]).toContain('/b/:id');
    });
});

describe('PathParams inference (compile-time contract)', () =>
{
    it('infers named params and wildcards from the pattern string', () =>
    {
        // PathParams builds intersections (object & { id: string }); assert keys and value
        // types (the meaning) rather than branded identity, which intersections fail.
        expectTypeOf<keyof PathParams<'/users/:id'>>().toEqualTypeOf<'id'>();
        expectTypeOf<PathParams<'/users/:id'>['id']>().toEqualTypeOf<string>();
        expectTypeOf<keyof PathParams<'/orgs/:org/repos/:repo'>>().toEqualTypeOf<'org' | 'repo'>();
        expectTypeOf<keyof PathParams<'/files/*path'>>().toEqualTypeOf<'path'>();
        expectTypeOf<PathParams<'/files/*path'>['path']>().toEqualTypeOf<string>();
        expectTypeOf<PathParams<'/static/route'>['toString']>().toEqualTypeOf<object['toString']>();
    });
});
