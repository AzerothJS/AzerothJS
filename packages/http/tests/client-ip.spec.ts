// @vitest-environment node
//
// The address trust boundary in isolation: the two forwarded-header selection rules (one per
// accumulation shape) every forwarded-header reader shares, and ipBucket's canonicalization
// of the spellings that name one host - same host, one bucket, whatever the proxy's formatting.

import { describe, it, expect } from 'vitest';
import { appendedForwardedEntry, replacedForwardedValue, ipBucket } from '../src/client-ip.ts';

describe('appendedForwardedEntry (per-hop headers such as X-Forwarded-For)', () =>
{
    it('selects from the RIGHT end by trusted hops - the left end is client-supplied', () =>
    {
        expect(appendedForwardedEntry('9.9.9.9, 203.0.113.7', 1)).toBe('203.0.113.7');
        expect(appendedForwardedEntry('9.9.9.9, 203.0.113.7, 10.0.0.1', 2)).toBe('203.0.113.7');
    });

    it('refuses a chain too short to have traversed the declared proxies', () =>
    {
        expect(appendedForwardedEntry('203.0.113.7', 2)).toBeUndefined();
        expect(appendedForwardedEntry('', 1)).toBeUndefined();
        expect(appendedForwardedEntry(undefined, 1)).toBeUndefined();
    });

    it('repeated header lines join into one chain, still indexed from the right', () =>
    {
        expect(appendedForwardedEntry(['a, b', 'c'], 1)).toBe('c');
        expect(appendedForwardedEntry(['a, b', 'c'], 2)).toBe('b');
    });
});

describe('replacedForwardedValue (whole-value headers such as X-Forwarded-Proto/-Host)', () =>
{
    it('believes the single entry a proxy chain leaves, at ANY chain depth', () =>
    {
        // nginx, HAProxy, Traefik, ALB and Cloudflare each SET these headers, so two proxies
        // in front produce exactly what one produces - no hop count can be applied to it.
        expect(replacedForwardedValue('app.example.com')).toBe('app.example.com');
        expect(replacedForwardedValue('https')).toBe('https');
        expect(replacedForwardedValue(' app.example.com:8443 ')).toBe('app.example.com:8443');
    });

    it('takes the last-written entry when a client value survives beside the proxy value', () =>
    {
        expect(replacedForwardedValue('evil.example, app.example.com')).toBe('app.example.com');
        expect(replacedForwardedValue('gopher, https')).toBe('https');
        expect(replacedForwardedValue(['evil.example', 'app.example.com'])).toBe('app.example.com');
    });

    it('has nothing to believe in an absent or empty header', () =>
    {
        expect(replacedForwardedValue(undefined)).toBeUndefined();
        expect(replacedForwardedValue('')).toBeUndefined();
        expect(replacedForwardedValue(' , ')).toBeUndefined();
    });
});

describe('ipBucket canonicalizes every spelling of one host', () =>
{
    it('collapses all IPv4-mapped spellings onto the IPv4 bucket', () =>
    {
        expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
        expect(ipBucket('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9');
        expect(ipBucket('::ffff:cb00:7109')).toBe('203.0.113.9');
    });

    it('an embedded dotted-quad tail buckets like its hex-pair form', () =>
    {
        expect(ipBucket('2001:db8::192.0.2.1')).toBe(ipBucket('2001:db8::c000:201'));
        expect(ipBucket('2001:db8::192.0.2.1')).toMatch(/\/64$/);
    });

    it('out-of-range octets are garbage, not an address', () =>
    {
        expect(ipBucket('::ffff:999.0.0.1')).toBe('::ffff:999.0.0.1');
    });

    it('brackets, port and zone name a connection, not a host, so they share one bucket', () =>
    {
        expect(ipBucket('[::ffff:203.0.113.9]')).toBe('203.0.113.9');
        expect(ipBucket('[::ffff:203.0.113.9]:443')).toBe('203.0.113.9');
        expect(ipBucket('203.0.113.9:443')).toBe('203.0.113.9');
        expect(ipBucket('[2001:db8::1]:8443')).toBe(ipBucket('2001:db8::1'));
        expect(ipBucket('[fe80::1%eth0]:80')).toBe(ipBucket('fe80::1'));
    });
});
