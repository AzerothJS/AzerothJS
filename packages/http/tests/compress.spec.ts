// @vitest-environment node
//
// Negotiated compression: the encoded body must DECODE back to the original (round-trip
// through node:zlib), the pass-through cases must return the very same Response object, and
// Vary must always ride along - the header whose absence poisons shared caches.

import { describe, it, expect } from 'vitest';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { compressResponse } from '../src/compress.ts';
import { json, text } from '../src/respond.ts';

const LONG = 'azeroth '.repeat(500); // ~4 KB of compressible text

function requestAccepting(encoding: string | null): Request
{
    return new Request('http://local/', encoding === null ? {} : { headers: { 'accept-encoding': encoding } });
}

async function decoded(response: Response): Promise<string>
{
    const raw = Buffer.from(await response.arrayBuffer());
    const encoding = response.headers.get('content-encoding');
    const plain = encoding === 'br' ? brotliDecompressSync(raw)
        : encoding === 'gzip' ? gunzipSync(raw)
            : encoding === 'deflate' ? inflateSync(raw)
                : raw;
    return plain.toString('utf8');
}

describe('encoding negotiation and round-trip', () =>
{
    it('prefers brotli, then gzip, then deflate', async () =>
    {
        const brotli = compressResponse(requestAccepting('gzip, deflate, br'), text(LONG));
        expect(brotli.headers.get('content-encoding')).toBe('br');
        expect(await decoded(brotli)).toBe(LONG);

        const gzip = compressResponse(requestAccepting('gzip, deflate'), text(LONG));
        expect(gzip.headers.get('content-encoding')).toBe('gzip');
        expect(await decoded(gzip)).toBe(LONG);

        const deflate = compressResponse(requestAccepting('deflate'), text(LONG));
        expect(deflate.headers.get('content-encoding')).toBe('deflate');
        expect(await decoded(deflate)).toBe(LONG);
    });

    it('a wildcard Accept-Encoding gets gzip (the universally safe pick)', async () =>
    {
        const response = compressResponse(requestAccepting('*'), text(LONG));
        expect(response.headers.get('content-encoding')).toBe('gzip');
    });

    it('drops Content-Length and appends Vary', () =>
    {
        const response = compressResponse(requestAccepting('gzip'), text(LONG));
        expect(response.headers.get('content-length')).toBeNull();
        expect(response.headers.get('vary')).toContain('accept-encoding');
    });

    it('JSON compresses too', async () =>
    {
        const payload = { rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${ i }` })) };
        const response = compressResponse(requestAccepting('gzip'), json(payload));
        expect(response.headers.get('content-encoding')).toBe('gzip');
        expect(JSON.parse(await decoded(response))).toEqual(payload);
    });
});

describe('pass-through cases return the SAME response object', () =>
{
    it('no Accept-Encoding overlap', () =>
    {
        const original = text(LONG);
        expect(compressResponse(requestAccepting(null), original)).toBe(original);
        expect(compressResponse(requestAccepting('zstd'), original)).toBe(original);
    });

    it('non-compressible types (already entropy-coded)', () =>
    {
        const original = new Response(new Uint8Array(4096), { headers: { 'content-type': 'image/png' } });
        expect(compressResponse(requestAccepting('gzip, br'), original)).toBe(original);
    });

    it('bodies DECLARED under the threshold (kernel constructors always declare) pass through', () =>
    {
        const original = new Response('tiny', {
            headers: { 'content-type': 'text/plain', 'content-length': '4' }
        });
        expect(compressResponse(requestAccepting('gzip'), original)).toBe(original);
    });

    it('an UNDECLARED length compresses even when small - unknown means "compress"', () =>
    {
        // The kernel's own constructors always declare Content-Length (so tiny bodies pass
        // through above); a RAW streamed Response declares nothing - the threshold cannot
        // prove it small, and wrongly skipping a large streamed body would be the worse error.
        const raw = new Response('tiny', { headers: { 'content-type': 'text/plain' } });
        const response = compressResponse(requestAccepting('gzip'), raw);
        expect(response.headers.get('content-encoding')).toBe('gzip');
    });

    it('already-encoded and bodyless responses', () =>
    {
        const encoded = new Response(LONG, { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } });
        expect(compressResponse(requestAccepting('br'), encoded)).toBe(encoded);

        const empty = new Response(null, { status: 304 });
        expect(compressResponse(requestAccepting('gzip'), empty)).toBe(empty);
    });
});
