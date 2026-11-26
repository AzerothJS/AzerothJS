// @vitest-environment node
//
// Negotiated compression: the encoded body must DECODE back to the original (round-trip
// through node:zlib), ineligible bodies keep their Response object, and
// Vary must always ride along - the header whose absence poisons shared caches.

import { describe, it, expect, vi } from 'vitest';
import { brotliCompressSync, brotliDecompressSync, constants, createGzip, gunzipSync, inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compressResponse } from '../src/compress.ts';
import { App, conditional, csrfCookie, etagFor, json, pipeline, requestId, securityHeaders, text } from '@azerothjs/http';
import { compress, contentTypeFor, staticFiles } from '@azerothjs/http/node';

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

    it.each(['scene.gltf', 'app.webmanifest'])('compresses the JSON media type served for %s', async file =>
    {
        const payload = JSON.stringify({ name: LONG });
        const response = compressResponse(requestAccepting('gzip'), new Response(payload, {
            headers: { 'content-type': contentTypeFor(file), 'content-length': String(Buffer.byteLength(payload)) }
        }));
        expect(response.headers.get('content-encoding')).toBe('gzip');
        expect(await decoded(response)).toBe(payload);
    });

    it.each(['model/gltf-binary', 'Font/TTF; version=1', 'font/otf', 'image/bmp'])(
        'round-trips the binary bytes of %s with Brotli and gzip', async type =>
        {
            const bytes = Buffer.alloc(4096, Buffer.from([0x00, 0xff, 0x80, 0x01]));
            const headers = { 'content-type': type, 'content-length': String(bytes.length) };
            for (const [coding, decompress] of [['br', brotliDecompressSync], ['gzip', gunzipSync]] as const)
            {
                const response = compressResponse(requestAccepting(coding), new Response(bytes, { headers }));
                expect(response.headers.get('content-encoding')).toBe(coding);
                expect(response.headers.get('content-type')).toBe(type);
                expect(decompress(Buffer.from(await response.arrayBuffer()))).toEqual(bytes);
            }
        }
    );
});

describe('identity and ineligible responses', () =>
{
    it('eligible identity responses vary by Accept-Encoding without mutating a shared response', async () =>
    {
        const original = text(LONG);
        for (const encoding of [null, 'identity', 'zstd'])
        {
            const response = compressResponse(requestAccepting(encoding), original);
            expect(response.headers.get('vary')).toBe('accept-encoding');
            expect(response.headers.get('content-encoding')).toBeNull();
            expect(await response.text()).toBe(LONG);
        }
        expect(original.headers.get('vary')).toBeNull();
        expect(original.bodyUsed).toBe(false);
    });

    it.each([
        'font/woff', 'font/woff2', 'image/x-icon', 'image/png', 'image/jpeg', 'image/webp',
        'image/avif', 'audio/mpeg', 'video/mp4', 'text/event-stream', 'application/octet-stream'
    ])('passes through %s regardless of how compressible the bytes are', type =>
    {
        const original = new Response(new Uint8Array(4096), { headers: { 'content-type': type } });
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
        const result = compressResponse(requestAccepting('gzip'), empty);
        expect(result.body).toBeNull();
        expect(result.headers.get('content-encoding')).toBeNull();
        expect(result.headers.get('vary')).toBe('accept-encoding');
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
        expect(compressResponse(requestAccepting('gzip;q=0'), original).headers.get('content-encoding')).toBeNull();
        expect(compressResponse(requestAccepting('*;q=0'), original).headers.get('content-encoding')).toBeNull();
        expect(compressResponse(requestAccepting('br;q=0, gzip;q=0, deflate;q=0'), original).headers.get('content-encoding')).toBeNull();
        expect(compressResponse(requestAccepting('identity;q=0'), original).headers.get('content-encoding')).toBeNull();
    });

    it('the heaviest weight wins over our own preference order', () =>
    {
        expect(compressResponse(requestAccepting('br;q=0.2, gzip;q=0.9'), text(LONG)).headers.get('content-encoding')).toBe('gzip');
        expect(compressResponse(requestAccepting('gzip;q=0.4, deflate;q=0.9'), text(LONG)).headers.get('content-encoding')).toBe('deflate');
    });

    it('a coding listed twice keeps its lowest weight - a refusal anywhere is a refusal', () =>
    {
        const original = text(LONG);
        expect(compressResponse(requestAccepting('gzip, gzip;q=0'), original).headers.get('content-encoding')).toBeNull();
        expect(compressResponse(requestAccepting('gzip;q=0, gzip'), original).headers.get('content-encoding')).toBeNull();
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
        expect(response.headers.get('etag')).toBe('W/"14-1a2b-gzip"');
        expect(response.headers.get('accept-ranges')).toBeNull();
    });

    it('a weak validator stays weak', () =>
    {
        const original = new Response(LONG, { headers: { 'content-type': 'text/plain', etag: 'W/"14-1a2b"' } });
        expect(compressResponse(requestAccepting('br'), original).headers.get('etag')).toBe('W/"14-1a2b-br"');
    });
});

describe('compression level and public middleware', () =>
{
    it('encodes known-length bodies with the requested codec options', async () =>
    {
        const body = Array.from({ length: 2200 }, (_, i) => `parcel-${ i % 193 } dispatch ${ i % 59 }\n`).join('');
        for (const quality of [0, 5, 11])
        {
            const settings = quality === 5 ? {} : { brotliQuality: quality };
            const result = compressResponse(requestAccepting('br'), text(body), settings);
            expect(Buffer.from(await result.arrayBuffer())).toEqual(brotliCompressSync(body, {
                params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT }
            }));
        }
        for (const level of [-1, 0, 9])
        {
            const result = compressResponse(requestAccepting('gzip'), text(body), { gzipLevel: level });
            const expected = await buffer(Readable.from([body]).pipe(createGzip({ level })));
            expect(Buffer.from(await result.arrayBuffer())).toEqual(expected);
        }
    });

    it.each([{ brotliQuality: -1 }, { brotliQuality: 12 }, { brotliQuality: 4.5 },
        { gzipLevel: -2 }, { gzipLevel: 10 }, { gzipLevel: NaN }])('rejects invalid levels at configuration and direct call', options =>
    {
        expect(() => compress(options)).toThrow(RangeError);
        expect(() => compressResponse(requestAccepting('br'), text(LONG), options)).toThrow(RangeError);
    });

    it.each(['br', 'gzip', 'deflate'])('describes and revalidates the %s representation through an outer pipeline', async coding =>
    {
        const app = new App();
        const value = { rows: LONG };
        const base = etagFor(value, 'parcels');
        app.get('/', context => conditional(context.request, value, { scope: 'parcels' }));
        const handler = pipeline(app, compress(), requestId(), securityHeaders(), csrfCookie());
        const ask = (method: string, validator?: string, encoding = coding): Promise<Response> => handler.handle(
            new Request('http://local/', { method, headers: {
                'accept-encoding': encoding, ...(validator === undefined ? {} : { 'if-none-match': validator })
            } })
        );
        const get = await ask('GET');
        const tag = get.headers.get('etag')!;
        expect(tag).toBe(`W/${ base.slice(0, -1) }-${ coding }"`);
        expect(await decoded(get)).toBe(JSON.stringify(value));
        const head = await ask('HEAD');
        expect(head.body).toBeNull();
        for (const key of ['etag', 'vary', 'content-encoding', 'content-length', 'accept-ranges'])
        {
            expect(head.headers.get(key)).toBe(get.headers.get(key));
        }
        for (const method of ['GET', 'HEAD'])
        {
            for (const validator of [tag, `"other", ${ tag.slice(2) }`, `${ base }, ${ tag }`, '*'])
            {
                const cached = await ask(method, validator);
                expect(cached.status).toBe(304);
                expect(cached.body).toBeNull();
                expect(cached.headers.get('etag')).toBe(tag);
                expect(cached.headers.get('vary')).toBe('accept-encoding');
                expect(cached.headers.get('content-length')).toBeNull();
                expect(cached.headers.has('x-request-id')).toBe(true);
                if (method === 'GET')
                {
                    expect(cached.headers.getSetCookie()).toHaveLength(1);
                }
            }
        }
        const identity = await ask('GET', base);
        expect(identity.status).toBe(304);
        expect(identity.headers.get('etag')).toBe(base);
        expect(identity.headers.get('vary')).toBe('accept-encoding');
        expect(identity.headers.get('content-encoding')).toBeNull();
        const other = await ask('GET', tag, `${ coding };q=0`);
        expect(other.status).toBe(200);
        expect(await other.json()).toEqual(value);
    });

    it('leaves an upstream 304 validator alone when the GET was small or already encoded', async () =>
    {
        for (const encoded of [false, true])
        {
            const app = new App();
            const etag = encoded ? '"stored-br"' : '"tiny"';
            app.get('/', context =>
            {
                const headers = new Headers({ 'content-type': 'text/plain', etag });
                if (context.request.headers.has('if-modified-since') || context.request.headers.has('if-none-match'))
                {
                    return new Response(null, { status: 304, headers });
                }
                const body = encoded ? brotliCompressSync(LONG) : 'abc';
                if (encoded)
                {
                    headers.set('content-encoding', 'br');
                }
                headers.set('content-length', String(body.length));
                return new Response(body, { headers });
            });
            const handler = pipeline(app, compress(), securityHeaders(), csrfCookie());
            const get = await handler.handle(requestAccepting('br, gzip'));
            expect(get.headers.get('content-encoding')).toBe(encoded ? 'br' : null);
            expect(await decoded(get)).toBe(encoded ? LONG : 'abc');
            for (const [name, value] of [['if-none-match', '*'], ['if-modified-since', new Date().toUTCString()]] as const)
            {
                const req = requestAccepting('br, gzip');
                req.headers.set(name, value);
                const cached = await handler.handle(req);
                expect(cached.status).toBe(304);
                expect(cached.body).toBeNull();
                expect(cached.headers.get('etag')).toBe(etag);
                expect(cached.headers.get('content-encoding')).toBeNull();
                expect(cached.headers.get('vary')).toBe('accept-encoding');
            }
        }
        // Even a size supplied by a third-party 304 does not prove that the GET permitted
        // transformation. Its cache policy or content coding may have been omitted.
        const cached = new Response(null, { status: 304, headers: { 'content-type': 'text/plain', 'content-length': '4096', etag: '"opaque"' } });
        const result = compressResponse(requestAccepting('br'), cached);
        expect(result.headers.get('etag')).toBe('"opaque"');
        expect(result.headers.get('content-length')).toBe('4096');
        expect(result.headers.get('content-encoding')).toBeNull();
    });

    it('preserves static date revalidation and no-transform policy through header decorators', async () =>
    {
        const dir = await mkdtemp(path.join(tmpdir(), 'azeroth-revalidate-'));
        try
        {
            await writeFile(path.join(dir, 'parcel.txt'), LONG);
            const app = new App();
            app.get('/live/*path', staticFiles(dir, { cacheControl: 'private' }));
            app.get('/signed/*path', staticFiles(dir, { cacheControl: 'private, no-transform' }));
            const handler = pipeline(app, compress(), requestId(), securityHeaders(), csrfCookie());
            for (const route of ['live', 'signed'])
            {
                const req = new Request(`http://local/${ route }/parcel.txt`, { headers: { 'accept-encoding': 'br' } });
                const get = await handler.handle(req);
                expect(get.headers.get('content-encoding')).toBe(route === 'live' ? 'br' : null);
                expect(await decoded(get)).toBe(LONG);
                req.headers.set('if-modified-since', get.headers.get('last-modified')!);
                const cached = await handler.handle(req);
                expect(cached.status).toBe(304);
                expect(cached.headers.get('etag')).toBe(get.headers.get('etag'));
                expect(cached.headers.get('content-encoding')).toBe(get.headers.get('content-encoding'));
                expect(cached.headers.get('vary')).toBe(get.headers.get('vary'));
                expect(cached.headers.getSetCookie()).toHaveLength(1);
            }
        }
        finally
        {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('distinguishes an actual empty GET from a suppressed stream on HEAD', async () =>
    {
        const app = new App();
        const headers = { 'content-type': 'text/plain', etag: '"parcel"' };
        app.get('/empty', () => new Response(null, { headers }));
        app.get('/stream', () => new Response(LONG, { headers }));
        const handler = pipeline(app, compress(), requestId(), securityHeaders(), csrfCookie());
        for (const route of ['empty', 'stream'])
        {
            for (const method of ['GET', 'HEAD'])
            {
                const req = new Request(`http://local/${ route }`, { method, headers: { 'accept-encoding': 'gzip' } });
                const result = await handler.handle(req);
                const streamed = route === 'stream';
                expect(result.headers.get('etag')).toBe(streamed ? 'W/"parcel-gzip"' : '"parcel"');
                expect(result.headers.get('content-encoding')).toBe(streamed ? 'gzip' : null);
                expect(result.headers.get('vary')).toBe(streamed ? 'accept-encoding' : null);
                if (method === 'GET' && streamed)
                {
                    expect(await decoded(result)).toBe(LONG);
                }
                else
                {
                    expect(result.body).toBeNull();
                }
            }
        }
    });

    it('negotiates a separately registered HEAD that declares the size of its GET', async () =>
    {
        const app = new App();
        const headers = { 'content-type': 'text/plain', 'content-length': String(LONG.length), etag: '"parcel"' };
        app.get('/', () => new Response(LONG, { headers }));
        app.route('HEAD', '/', () => new Response(null, { headers }));
        const handler = pipeline(app, compress());
        const get = await handler.handle(requestAccepting('br'));
        const head = await handler.handle(new Request(requestAccepting('br'), { method: 'HEAD' }));
        expect(get.headers.get('content-encoding')).toBe('br');
        expect(await decoded(get)).toBe(LONG);
        expect([...head.headers]).toEqual([...get.headers]);
        expect(head.body).toBeNull();
    });

    it('releases the original stream on a direct HEAD and on a negotiated cache hit', () =>
    {
        for (const method of ['GET', 'HEAD'])
        {
            const stop = vi.fn();
            const response = new Response(new ReadableStream({ cancel: stop }), {
                headers: { 'content-type': 'text/plain', etag: '"parcel"' }
            });
            const cached = compressResponse(new Request('http://local/', { method, headers: {
                'accept-encoding': 'gzip', 'if-none-match': '"parcel-gzip"'
            } }), response);
            expect(cached.status).toBe(304);
            expect(cached.body).toBeNull();
            expect(stop).toHaveBeenCalledTimes(1);
        }
    });

    it('retains previous variation tokens and separate cookies in both representations', async () =>
    {
        for (const vary of ['Origin', 'ACCEPT-ENCODING', '*'])
        {
            for (const encoding of ['identity', 'gzip'])
            {
                const headers = new Headers({ vary });
                headers.append('set-cookie', 'one=1');
                headers.append('set-cookie', 'two=2');
                const response = compressResponse(requestAccepting(encoding), text(LONG, { headers }));
                expect(response.headers.get('vary')).toBe(vary === 'Origin' ? 'Origin, accept-encoding' : vary);
                expect(response.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
                expect(await decoded(response)).toBe(LONG);
            }
        }
    });

    it('can add Vary to an immutable fetch response', async () =>
    {
        const fetched = await fetch('data:text/plain,' + encodeURIComponent(LONG));
        const result = compressResponse(requestAccepting('identity'), fetched);
        expect(result.headers.get('vary')).toBe('accept-encoding');
        expect(fetched.headers.get('vary')).toBeNull();
        expect(await result.text()).toBe(LONG);
    });

    it('preserves a full identity response to a range request', async () =>
    {
        const req = new Request('http://local/', { headers: { range: 'bytes=2-7', 'accept-encoding': 'br' } });
        const response = compressResponse(req, text(LONG));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-encoding')).toBeNull();
        expect(await response.text()).toBe(LONG);
    });

    it('only converts eligible successful GET and HEAD representations to 304', async () =>
    {
        const headers = { 'accept-encoding': 'gzip', 'if-none-match': '"parcel-gzip"' };
        const request = new Request('http://local/', { headers });
        const write = new Request('http://local/', { method: 'POST', headers });
        const retry = compressResponse(write, text(LONG, { headers: { etag: '"parcel"' } }));
        expect(retry.status).toBe(200);
        expect(await decoded(retry)).toBe(LONG);
        const missing = compressResponse(request, text(LONG, { status: 404, headers: { etag: '"parcel"' } }));
        expect(missing.status).toBe(404);
        expect(await decoded(missing)).toBe(LONG);
        const tiny = compressResponse(request, text('small', { headers: { etag: '"parcel"' } }));
        expect(tiny.status).toBe(200);
        expect(tiny.headers.get('vary')).toBeNull();
        expect(await tiny.text()).toBe('small');
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

    it('a client that stalls mid-download and then disconnects cannot kill the process', async () =>
    {
        // The one shape that reaches the race: a real socket, read far enough to fill the pipe,
        // then STALL until the producer parks on backpressure, then destroy. A zlib stream
        // flushing per chunk has output in flight at that moment, and a boundary that keeps
        // enqueueing after the cancel throws synchronously inside the emitter, above every
        // framework catch - an uncaught exception, which only a separate process tells from a
        // handled error.
        //
        // The park is OBSERVED rather than assumed: the child polls until the producer stops
        // advancing and reports NO-PARK if it never does, so a machine that cannot arm the
        // trigger fails loudly here instead of passing green while testing nothing. An
        // in-process cancel does NOT reproduce it (measured): the socket is what leaves the
        // producer parked with a chunk still to come.
        const dir = await mkdtemp(path.join(tmpdir(), 'azeroth-compress-'));
        const script = path.join(dir, 'stall-then-disconnect.mjs');
        const here = path.dirname(fileURLToPath(import.meta.url));
        const nodeUrl = pathToFileURL(path.join(here, '..', 'src', 'node.ts')).href;
        const appUrl = pathToFileURL(path.join(here, '..', 'src', 'app.ts')).href;
        const child = [
            "import { connect } from 'node:net';",
            `import { App } from ${ JSON.stringify(appUrl) };`,
            `import { compressResponse, serve } from ${ JSON.stringify(nodeUrl) };`,
            '',
            'const CHUNK = new Uint8Array(65536).fill(120);',
            'let produced = 0;',
            'const app = new App({ onError: () => undefined, onStreamError: () => undefined });',
            "app.get('/download', (context) =>",
            '{',
            '    const body = new ReadableStream({',
            '        pull(controller)',
            '        {',
            '            produced++;',
            '            if (produced >= 20000) { controller.close(); return; }',
            '            controller.enqueue(CHUNK);',
            '        },',
            '        cancel() {}',
            '    });',
            "    return compressResponse(context.request, new Response(body, { headers: { 'content-type': 'text/plain' } }));",
            '});',
            'const served = await serve(app, { port: 0 });',
            "const socket = connect(served.port, '127.0.0.1');",
            "await new Promise((resolve) => socket.once('connect', resolve));",
            'socket.write(\'GET /download HTTP/1.1\\r\\nHost: x\\r\\nAccept-Encoding: gzip\\r\\n\\r\\n\');',
            'let received = 0;',
            "await new Promise((resolve) => socket.on('data', (chunk) =>",
            '{',
            '    received += chunk.length;',
            '    if (received >= 65536) { socket.pause(); resolve(); }',
            '}));',
            'let parked = false;',
            'let previous = -1;',
            'for (let i = 0; i < 200; i++)',
            '{',
            '    await new Promise((resolve) => setTimeout(resolve, 50));',
            '    if (produced === previous) { parked = true; break; }',
            '    previous = produced;',
            '}',
            "if (!parked) { console.log('NO-PARK'); process.exit(0); }",
            'socket.destroy();',
            'await new Promise((resolve) => setTimeout(resolve, 500));',
            "console.log('SURVIVED');",
            'await served.shutdown({ gracePeriodMs: 200 }).catch(() => undefined);'
        ].join('\n');
        await writeFile(script, child);

        const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
        expect(run.stdout).not.toContain('NO-PARK');
        expect(run.stdout.trim().split('\n').pop()).toBe('SURVIVED');
        expect(run.status).toBe(0);
    }, 30_000);

    it('cancelling forwards the reason, so the source can still tell an abort from a broken pipe', async () =>
    {
        // The reason is how a source distinguishes "the client left" from "the pipe broke", and
        // this boundary is the only thing between the two. A cancel that dropped it would answer
        // every abandoned download with the same anonymous teardown.
        let reason: unknown;
        const source = new ReadableStream<Uint8Array>({
            pull(controller)
            {
                controller.enqueue(new TextEncoder().encode(LONG));
            },
            cancel(given)
            {
                reason = given;
            }
        });
        const response = compressResponse(
            requestAccepting('gzip'),
            new Response(source, { headers: { 'content-type': 'text/plain' } })
        );

        const reader = response.body!.getReader();
        await reader.read();
        const abort = new Error('the reader went away');
        abort.name = 'AbortError';
        await reader.cancel(abort);
        await vi.waitFor(() => expect(reason).toBeDefined());
        expect((reason as Error).name).toBe('AbortError');
    });

});
