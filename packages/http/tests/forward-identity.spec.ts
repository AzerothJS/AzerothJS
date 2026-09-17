// @vitest-environment node
//
// forwardIdentity is an ALLOWLIST, and these arms are written to fail on a denylist.
//
// The header set is asserted by EQUALITY rather than by absence: a denylist that transcribed the
// refusal list would pass an absence check and still leak the names nobody enumerated
// (accept-encoding, user-agent, cache-control). The request-id arm catches the other denylist
// shape - a forged x-request-id is on no refusal list at all, and forwarding it hands a sub-call
// a correlation id the visitor chose.
import { describe, expect, it } from 'vitest';

import { forwardIdentity } from '../src/forward-identity.ts';
import { requestIdOf, stampRequestId } from '../src/edge.ts';

/** A page request as it arrives from the wire, forged headers included. */
function pageRequest(extra: Record<string, string> = {}): Request
{
    return new Request('http://page.example/dashboard', {
        headers: {
            cookie: 'visitor=alice',
            authorization: 'Bearer page-token',
            'accept-language': 'fa-IR,fa;q=0.9',
            host: 'page.example',
            'content-length': '0',
            connection: 'keep-alive',
            origin: 'http://evil.example',
            referer: 'http://evil.example/lure',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-dest': 'document',
            'x-forwarded-for': '9.9.9.9',
            'if-none-match': '"etag"',
            range: 'bytes=0-99',
            'x-azeroth-csrf': 'forged',
            'accept-encoding': 'gzip, br',
            'user-agent': 'probe/1.0',
            'cache-control': 'no-cache',
            ...extra
        }
    });
}

describe('forwardIdentity', () =>
{
    it('carries exactly cookie, authorization and accept-language, and stamps the trusted request id', () =>
    {
        const from = pageRequest();
        stampRequestId(from, 'page-0001');
        const to = new Request('http://page.example/api/me', { headers: { accept: 'application/json' } });

        const forwarded = forwardIdentity(from, to);

        // By EQUALITY: the names the call set, plus the three. Anything a denylist let through
        // shows up as an extra entry here rather than passing an absence check.
        expect([...forwarded.headers.keys()].sort()).toEqual([
            'accept', 'accept-language', 'authorization', 'cookie'
        ]);
        expect(forwarded.headers.get('cookie')).toBe('visitor=alice');
        expect(forwarded.headers.get('authorization')).toBe('Bearer page-token');
        expect(forwarded.headers.get('accept-language')).toBe('fa-IR,fa;q=0.9');
        expect(requestIdOf(forwarded)).toBe('page-0001');
        expect(forwarded.url).toBe('http://page.example/api/me');
    });

    it('never overwrites a header the call set for itself', () =>
    {
        const from = pageRequest();
        const to = new Request('http://page.example/api/deploy', {
            headers: { authorization: 'Bearer deploy-key', 'accept-language': 'en-GB' }
        });

        const forwarded = forwardIdentity(from, to);

        expect(forwarded.headers.get('authorization')).toBe('Bearer deploy-key');
        expect(forwarded.headers.get('accept-language')).toBe('en-GB');
        // The one the call did NOT set still arrives, so this is not a blanket refusal.
        expect(forwarded.headers.get('cookie')).toBe('visitor=alice');
    });

    it('forwards no client-supplied x-request-id when no trusted id was assigned', () =>
    {
        const from = pageRequest({ 'x-request-id': 'forged-by-the-client' });
        const to = new Request('http://page.example/api/me');

        const forwarded = forwardIdentity(from, to);

        expect(forwarded.headers.get('x-request-id')).toBeNull();
        expect(requestIdOf(forwarded)).toBeUndefined();
    });
});
