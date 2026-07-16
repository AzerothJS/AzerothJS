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
