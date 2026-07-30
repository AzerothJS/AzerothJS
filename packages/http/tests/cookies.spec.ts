// @vitest-environment node
//
// Cookies: lenient parsing of hostile inbound headers, loud validation of everything we emit.
// The serializer's errors exist because a browser silently DROPS a cookie violating the
// SameSite/prefix contracts - a thrown error at the call site is the only honest signal.

import { describe, it, expect } from 'vitest';
import { parseCookies, serializeCookie, expireCookie } from '../src/cookies.ts';

function requestWithCookie(header: string): Request
{
    return new Request('http://local/', { headers: { cookie: header } });
}

describe('parseCookies', () =>
{
    it('reads simple pairs', () =>
    {
        expect(parseCookies(requestWithCookie('a=1; b=two'))).toEqual({ a: '1', b: 'two' });
    });

    it('returns {} without a Cookie header', () =>
    {
        expect(parseCookies(new Request('http://local/'))).toEqual({});
    });

    it('first value wins on duplicates (the observable server convention)', () =>
    {
        expect(parseCookies(requestWithCookie('a=first; a=second'))).toEqual({ a: 'first' });
    });

    it('decodes our encoding and unwraps the quoted form', () =>
    {
        expect(parseCookies(requestWithCookie('name=caf%C3%A9'))).toEqual({ name: 'café' });
        expect(parseCookies(requestWithCookie('q="hello"'))).toEqual({ q: 'hello' });
    });

    it('skips malformed pairs and survives foreign percent signs', () =>
    {
        expect(parseCookies(requestWithCookie('justnoise; ok=1'))).toEqual({ ok: '1' });
        expect(parseCookies(requestWithCookie('raw=100%'))).toEqual({ raw: '100%' });
    });

    it('delivers cookies named after Object.prototype members instead of dropping them', () =>
    {
        const cookies = parseCookies(requestWithCookie('toString=a; constructor=b; __proto__=c'));
        expect(Object.entries(cookies)).toEqual([['toString', 'a'], ['constructor', 'b'], ['__proto__', 'c']]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // the record is data, never a prototype
    });

    it('a lone double-quote survives as itself, not an empty value', () =>
    {
        expect(parseCookies(requestWithCookie('q="'))).toEqual({ q: '"' });
    });
});

describe('serializeCookie', () =>
{
    it('emits safe defaults: Path=/, HttpOnly, SameSite=Lax', () =>
    {
        expect(serializeCookie('sid', 'abc')).toBe('sid=abc; Path=/; HttpOnly; SameSite=Lax');
    });

    it('round-trips arbitrary values through encoding', () =>
    {
        const header = serializeCookie('v', 'a; b="c" д');
        const value = header.slice(2, header.indexOf(';'));
        expect(decodeURIComponent(value)).toBe('a; b="c" д');
    });

    it('emits the full attribute set', () =>
    {
        const header = serializeCookie('sid', 'x', {
            maxAge: 3600, path: '/app', domain: 'example.com', secure: true, sameSite: 'strict'
        });
        expect(header).toContain('Max-Age=3600');
        expect(header).toContain('Path=/app');
        expect(header).toContain('Domain=example.com');
        expect(header).toContain('Secure');
        expect(header).toContain('SameSite=Strict');
    });

    it('rejects invalid names loudly', () =>
    {
        expect(() => serializeCookie('bad name', 'v')).toThrow(/not a valid cookie name/);
        expect(() => serializeCookie('bad=name', 'v')).toThrow(/not a valid cookie name/);
    });

    it('enforces SameSite=None + Secure (browsers reject the combination silently)', () =>
    {
        expect(() => serializeCookie('sid', 'x', { sameSite: 'none' })).toThrow(/requires Secure/);
        expect(serializeCookie('sid', 'x', { sameSite: 'none', secure: true })).toContain('SameSite=None');
    });

    it('rejects Path and Domain values that would smuggle extra attributes or split the header', () =>
    {
        // RFC 6265 5.2 parses duplicate attributes last-wins, so a ';' inside Path or Domain
        // rewrites the cookie's scope; a raw CR LF is header injection outright.
        expect(() => serializeCookie('sid', 'x', { path: '/; Domain=.example.com' })).toThrow(/not a valid cookie path/);
        expect(() => serializeCookie('sid', 'x', { path: '/\r\nSet-Cookie: e=1' })).toThrow(/not a valid cookie path/);
        expect(() => serializeCookie('sid', 'x', { path: '/a,b' })).toThrow(/not a valid cookie path/);
        expect(() => serializeCookie('sid', 'x', { domain: 'app.example.com; Path=/' })).toThrow(/not a valid cookie domain/);
        expect(() => serializeCookie('sid', 'x', { domain: 'ex\r\nample.com' })).toThrow(/not a valid cookie domain/);
        expect(() => expireCookie('sid', { path: '/; Domain=.example.com' })).toThrow(/not a valid cookie path/);
    });

    it('rejects a non-finite Max-Age instead of emitting Max-Age=NaN', () =>
    {
        expect(() => serializeCookie('sid', 'x', { maxAge: Number.NaN })).toThrow(/finite/);
        expect(() => serializeCookie('sid', 'x', { maxAge: Infinity })).toThrow(/finite/);
    });

    it('enforces the __Secure- and __Host- prefix contracts', () =>
    {
        expect(() => serializeCookie('__Secure-sid', 'x')).toThrow(/must set Secure/);
        expect(() => serializeCookie('__Host-sid', 'x', { secure: true, domain: 'e.com' })).toThrow(/__Host-/);
        expect(() => serializeCookie('__Host-sid', 'x', { secure: true, path: '/app' })).toThrow(/__Host-/);
        expect(serializeCookie('__Host-sid', 'x', { secure: true })).toContain('__Host-sid=x');
    });
});

describe('expireCookie', () =>
{
    it('emits an epoch-dated deletion with matching scope', () =>
    {
        const header = expireCookie('sid');
        expect(header).toContain('sid=');
        expect(header).toContain('Max-Age=0');
    });
});
