// @vitest-environment node
//
// Negotiated compression: the encoded body must DECODE back to the original (round-trip
// through node:zlib), the pass-through cases must return the very same Response object, and
// Vary must always ride along - the header whose absence poisons shared caches.

import { describe, it, expect, vi } from 'vitest';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

    it('a 206 partial response is NEVER compressed - byte ranges refer to the unencoded file', () =>
    {
        const partial = new Response(LONG.slice(0, 512), {
            status: 206,
            headers: { 'content-type': 'text/plain', 'content-range': 'bytes 0-511/4096' }
        });
        expect(compressResponse(requestAccepting('br, gzip'), partial)).toBe(partial);
    });

    it('a response marked no-transform is delivered as written', () =>
    {
        const signed = new Response(LONG, {
            headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60, no-transform' }
        });
        expect(compressResponse(requestAccepting('gzip, br'), signed)).toBe(signed);
    });
});

describe('q-values: a listed coding can be a REFUSAL (RFC 9110 12.5.3)', () =>
{
    it('q=0 is never served, and the codings around it still are', () =>
    {
        expect(compressResponse(requestAccepting('br;q=0, gzip'), text(LONG)).headers.get('content-encoding')).toBe('gzip');
        expect(compressResponse(requestAccepting('br, gzip;q=0, deflate'), text(LONG)).headers.get('content-encoding')).toBe('br');
        expect(compressResponse(requestAccepting('gzip;q=0, deflate;q=0.5'), text(LONG)).headers.get('content-encoding')).toBe('deflate');
    });

    it('refusing everything - explicitly or through the wildcard - passes the response through', () =>
    {
        const original = text(LONG);
        expect(compressResponse(requestAccepting('gzip;q=0'), original)).toBe(original);
        expect(compressResponse(requestAccepting('*;q=0'), original)).toBe(original);
        expect(compressResponse(requestAccepting('br;q=0, gzip;q=0, deflate;q=0'), original)).toBe(original);
        expect(compressResponse(requestAccepting('identity;q=0'), original)).toBe(original);
    });

    it('the heaviest weight wins over our own preference order', () =>
    {
        expect(compressResponse(requestAccepting('br;q=0.2, gzip;q=0.9'), text(LONG)).headers.get('content-encoding')).toBe('gzip');
        expect(compressResponse(requestAccepting('gzip;q=0.4, deflate;q=0.9'), text(LONG)).headers.get('content-encoding')).toBe('deflate');
    });

    it('a coding listed twice keeps its lowest weight - a refusal anywhere is a refusal', () =>
    {
        const original = text(LONG);
        expect(compressResponse(requestAccepting('gzip, gzip;q=0'), original)).toBe(original);
        expect(compressResponse(requestAccepting('gzip;q=0, gzip'), original)).toBe(original);
    });
});

describe('the encoded body is a DIFFERENT representation', () =>
{
    it('carries its own ETag and no Accept-Ranges', () =>
    {
        // A shared ETag is how a cache ends up revalidating its stored gzip body against the
        // identity tag and then serving gzip bytes to a client that asked for none.
        const original = new Response(LONG, {
            headers: { 'content-type': 'text/plain', etag: '"14-1a2b"', 'accept-ranges': 'bytes' }
        });
        const response = compressResponse(requestAccepting('gzip'), original);
        expect(response.headers.get('etag')).toBe('"14-1a2b-gzip"');
        expect(response.headers.get('accept-ranges')).toBeNull();
    });

    it('a weak validator stays weak', () =>
    {
        const original = new Response(LONG, { headers: { 'content-type': 'text/plain', etag: 'W/"14-1a2b"' } });
        expect(compressResponse(requestAccepting('br'), original).headers.get('etag')).toBe('W/"14-1a2b-br"');
    });
});

describe('a body that fails mid-stream', () =>
{
    const compressUrl = pathToFileURL(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'compress.ts')).href;

    it('rejects the reader instead of killing the process', async () =>
    {
        // A source error must not reach an EventEmitter with no 'error' listener - that is an
        // immediate process exit, so ONE failed report stream would take the whole server with
        // it. Only a separate process can prove the difference, hence the child.
        const dir = await mkdtemp(path.join(tmpdir(), 'azeroth-compress-'));
        const script = path.join(dir, 'mid-stream-failure.mjs');
        await writeFile(script, `
import { compressResponse } from ${ JSON.stringify(compressUrl) };

const failing = new ReadableStream({
    start(controller)
    {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
        setTimeout(() => controller.error(new Error('the report cursor died halfway')), 10);
    }
});
const response = compressResponse(
    new Request('http://local/report', { headers: { 'accept-encoding': 'gzip' } }),
    new Response(failing, { headers: { 'content-type': 'text/plain' } })
);
try
{
    await new Response(response.body).arrayBuffer();
    console.log('COMPLETED');
}
catch
{
    console.log('REJECTED');
}
`);

        const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
        expect(run.stdout.trim()).toBe('REJECTED');
        expect(run.status).toBe(0);
    }, 20_000);

    it('cancelling the compressed body tears the SOURCE down (one leaked fd per aborted download otherwise)', async () =>
    {
        const dir = await mkdtemp(path.join(tmpdir(), 'azeroth-compress-'));
        const file = path.join(dir, 'download.bin');
        await writeFile(file, randomBytes(2 * 1024 * 1024)); // incompressible, so zlib emits promptly
        const fileStream = createReadStream(file);
        const response = compressResponse(
            requestAccepting('gzip'),
            new Response(Readable.toWeb(fileStream) as ReadableStream<Uint8Array>, {
                headers: { 'content-type': 'text/plain' }
            })
        );

        const reader = response.body!.getReader();
        await reader.read();
        expect(fileStream.readableEnded).toBe(false); // still mid-download: teardown can only come from the cancel
        await reader.cancel();
        await vi.waitFor(() => expect(fileStream.destroyed).toBe(true));
    });
});
