// @vitest-environment node
//
// Conditional JSON responses. Two independently-built applications hand-wrote this file - a git
// forge polling branch heads and an issue tracker polling org lists - and agreed on every hard
// decision: a body hash, a tenant scope folded into the tag, `W/` stripping, and comma-split tag
// lists. The framework already contained the hard half, private to static file serving.
import { describe, expect, it } from 'vitest';
import { conditional, etagFor, matchesEtag } from '@azerothjs/http';

function ask(headers: Record<string, string> = {}): Request
{
    return new Request('http://local/api/things', { headers });
}

describe('etagFor', () =>
{
    it('is stable for the same value and changes when the value does', () =>
    {
        expect(etagFor({ a: 1 }, 'tenant-1')).toBe(etagFor({ a: 1 }, 'tenant-1'));
        expect(etagFor({ a: 1 }, 'tenant-1')).not.toBe(etagFor({ a: 2 }, 'tenant-1'));
    });

    it('differs per scope for an IDENTICAL body', () =>
    {
        // The multi-tenant cache-poisoning bug: without the scope, two tenants whose rows happen
        // to serialize the same share a validator and one is served the other's 304.
        expect(etagFor({ a: 1 }, 'tenant-1')).not.toBe(etagFor({ a: 1 }, 'tenant-2'));
    });

    it('is a quoted entity-tag', () =>
    {
        expect(etagFor({ a: 1 }, 's')).toMatch(/^"[^"]+"$/);
    });
});

describe('conditional', () =>
{
    it('returns 200 with an etag when the client has nothing', async () =>
    {
        const response = conditional(ask(), { rows: [1, 2] }, { scope: 's' });
        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).not.toBeNull();
        expect(await response.json()).toEqual({ rows: [1, 2] });
    });

    it('returns a bodyless 304 when the validator still matches', async () =>
    {
        const tag = etagFor({ rows: [1] }, 's');
        const response = conditional(ask({ 'if-none-match': tag }), { rows: [1] }, { scope: 's' });

        expect(response.status).toBe(304);
        expect(await response.text()).toBe('');
        // RFC 9110: a 304 carries the validator it matched.
        expect(response.headers.get('etag')).toBe(tag);
    });

    it('accepts a weak validator and a list of tags', () =>
    {
        const tag = etagFor({ rows: [1] }, 's');
        expect(conditional(ask({ 'if-none-match': `W/${ tag }` }), { rows: [1] }, { scope: 's' }).status).toBe(304);
        expect(conditional(ask({ 'if-none-match': `"stale", ${ tag }` }), { rows: [1] }, { scope: 's' }).status).toBe(304);
        expect(conditional(ask({ 'if-none-match': '*' }), { rows: [1] }, { scope: 's' }).status).toBe(304);
    });

    it('compares whole quoted tags, including commas, with weak comparison on either side', () =>
    {
        expect(matchesEtag('"parcel,21", W/"next"', 'W/"parcel,21"')).toBe(true);
        expect(matchesEtag('"parcel,21", W/"next"', '"next"')).toBe(true);
        expect(matchesEtag('"parcel,21"', '"21"')).toBe(false);
        expect(matchesEtag('"parcel,21"', '"parcel"')).toBe(false);
    });

    it('derives the validator and response bytes from one serialization', async () =>
    {
        let calls = 0;
        const value = { toJSON: () => ++calls };
        const response = conditional(ask(), value, { scope: 's' });
        expect(await response.json()).toBe(1);
        expect(response.headers.get('etag')).toBe(etagFor(1, 's'));
        expect(calls).toBe(1);
    });

    it('returns 200 when the body changed', () =>
    {
        const tag = etagFor({ rows: [1] }, 's');
        expect(conditional(ask({ 'if-none-match': tag }), { rows: [1, 2] }, { scope: 's' }).status).toBe(200);
    });

    it('NEVER serves one scope\'s 304 to another', () =>
    {
        const tag = etagFor({ rows: [1] }, 'tenant-1');
        const response = conditional(ask({ 'if-none-match': tag }), { rows: [1] }, { scope: 'tenant-2' });
        expect(response.status).toBe(200);
    });

    it('marks the response private by default, so a shared cache cannot hold it', () =>
    {
        const control = conditional(ask(), { a: 1 }, { scope: 's' }).headers.get('cache-control') ?? '';
        // A scoped response is per-caller by construction; a shared proxy must not store it.
        expect(control).toContain('private');
        expect(control).toContain('must-revalidate');
    });

    it('honours maxAge and an explicit public scope', () =>
    {
        const control = conditional(ask(), { a: 1 }, { scope: 's', maxAge: 60, shared: true }).headers.get('cache-control') ?? '';
        expect(control).toContain('public');
        expect(control).toContain('max-age=60');
    });
});
