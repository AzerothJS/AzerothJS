// @vitest-environment node
//
// THE CONTRACT: which middleware shapes preserve streaming, and which silently buffer.
//
// This is pinned as a test because the headers LIE. A wrapper that reads the body and rebuilds
// the response still answers `transfer-encoding: chunked` with no `content-length`, and
// `response.body instanceof ReadableStream` is still true - so nothing an application can
// inspect reveals that time-to-first-byte just went from ~2ms to ~400ms. Measured on a route
// that holds its second chunk: text() rewrap 407ms vs 2ms bare, a ~200x TTFB regression that
// looks identical on the wire.
//
// The rule that falls out, and what the READMEs now state:
//   READING the body (text/arrayBuffer/json/blob) buffers. Everything else does not.
//   Headers-only middleware and clone() - read or unread - stream fine.
//
// COMPRESSION IS ITS OWN CASE, and an earlier version of this file got it wrong. It does not
// buffer the RESPONSE, but the compressor holds bytes in its window, so the number that matters
// is when a CLIENT can DECODE - not when a byte reaches the socket. See the last describe block.
import { createBrotliDecompress, createGunzip } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { compressResponse } from '../src/compress.ts';
import { pipeline } from '../src/edge.ts';

const SLOW_MS = 60;

/** Padding so the response clears the compressibility threshold; small bodies are not encoded. */
const FILLER = 'azeroth '.repeat(400);

/** A route whose first bytes are ready immediately and whose last chunk is deliberately late. */
function streamingApp(): App
{
    const app = new App();
    app.get('/stream', () =>
    {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
            async start(controller)
            {
                controller.enqueue(encoder.encode('SHELL'));
                await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
                controller.enqueue(encoder.encode('LATE'));
                controller.close();
            }
        }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    return app;
}

/** Time until the FIRST chunk is readable - the only number that distinguishes the two. */
async function timeToFirstChunk(handler: { handle: (request: Request) => Promise<Response> }): Promise<{ ms: number; body: string }>
{
    const started = Date.now();
    const response = await handler.handle(new Request('http://local/stream'));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const ms = Date.now() - started;
    const decoder = new TextDecoder();
    let body = decoder.decode(first.value ?? new Uint8Array(), { stream: true });
    for (;;)
    {
        const next = await reader.read();
        if (next.done)
        {
            break;
        }
        body += decoder.decode(next.value, { stream: true });
    }
    return { ms, body };
}

describe('middleware that PRESERVES streaming', () =>
{
    it('a bare streaming route delivers its first chunk before the slow one is ready', async () =>
    {
        const { ms, body } = await timeToFirstChunk(streamingApp());
        expect(ms).toBeLessThan(SLOW_MS);
        expect(body).toBe('SHELLLATE');
    });

    it('headers-only middleware (requestId/securityHeaders shape) stays streaming', async () =>
    {
        const handler = pipeline(streamingApp(), (next) => ({
            handle: async (request: Request) =>
            {
                const response = await next.handle(request);
                response.headers.set('x-observed', '1');
                return response;
            }
        }));
        const { ms } = await timeToFirstChunk(handler);
        expect(ms).toBeLessThan(SLOW_MS);
    });

    it('clone() does NOT buffer, even when the clone is fully read', async () =>
    {
        // Worth pinning because it is the non-obvious one: a logging/audit sink can tee the
        // whole body without costing the client its first byte.
        const seen: string[] = [];
        const handler = pipeline(streamingApp(), (next) => ({
            handle: async (request: Request) =>
            {
                const response = await next.handle(request);
                void response.clone().text().then((text) => seen.push(text));
                return response;
            }
        }));
        const { ms, body } = await timeToFirstChunk(handler);
        expect(ms).toBeLessThan(SLOW_MS);
        expect(body).toBe('SHELLLATE');
    });
});

describe('middleware that SILENTLY BUFFERS', () =>
{
    it('reading the body with text() and rebuilding converts streaming into buffering', async () =>
    {
        // The `brandPages` shape: read the HTML, rewrite it, hand back a new Response. Every
        // byte now waits for the slowest chunk.
        const handler = pipeline(streamingApp(), (next) => ({
            handle: async (request: Request) =>
            {
                const response = await next.handle(request);
                const html = await response.text();
                return new Response(html.replace('SHELL', 'BRANDED'), {
                    status: response.status,
                    headers: response.headers
                });
            }
        }));
        const { ms, body } = await timeToFirstChunk(handler);
        expect(ms).toBeGreaterThanOrEqual(SLOW_MS);
        expect(body).toBe('BRANDEDLATE');
    });

    it('arrayBuffer() buffers the same way', async () =>
    {
        const handler = pipeline(streamingApp(), (next) => ({
            handle: async (request: Request) =>
            {
                const response = await next.handle(request);
                const bytes = await response.arrayBuffer();
                return new Response(bytes, { status: response.status, headers: response.headers });
            }
        }));
        const { ms } = await timeToFirstChunk(handler);
        expect(ms).toBeGreaterThanOrEqual(SLOW_MS);
    });

    it('the buffered response is INDISTINGUISHABLE by inspection - which is why this is documented', async () =>
    {
        const handler = pipeline(streamingApp(), (next) => ({
            handle: async (request: Request) =>
            {
                const response = await next.handle(request);
                const html = await response.text();
                return new Response(html, { status: response.status, headers: response.headers });
            }
        }));
        const response = await handler.handle(new Request('http://local/stream'));
        // Both of these still look exactly like a streaming response.
        expect(response.body).toBeInstanceOf(ReadableStream);
        expect(response.headers.get('content-length')).toBeNull();
    });
});

describe('compression must not defeat streaming at the DECODER', () =>
{
    // The correction this pins. An earlier pass measured compression at the WIRE and concluded
    // "compression preserves streaming". Bytes did arrive early - but the compressor holds them
    // in its window, so a CLIENT could not DECODE the shell until enough accumulated. Measured
    // before the fix, against a shell followed by a 300 ms hold: brotli produced no decodable
    // content before the hold at ANY size tested (3 KB to 256 KB), and gzip only when the shell
    // was both large and incompressible. The shell was on the wire in 2 ms and painted at 300 ms,
    // and no header anywhere said so.
    //
    // The fix flushes per chunk for streamed responses only (no content-length), costing ~10-20%
    // of encoded size on real page HTML and keeping the tighter encoding for buffered responses.
    /** Like streamingApp() but padded past the compressibility threshold. */
    function compressibleStreamingApp(): App
    {
        const app = new App();
        app.get('/stream', () =>
        {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller)
                {
                    controller.enqueue(encoder.encode(`SHELL${ FILLER }`));
                    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
                    controller.enqueue(encoder.encode('LATE'));
                    controller.close();
                }
            }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        });
        return app;
    }

    async function firstDecodableAt(encoding: 'gzip' | 'br'): Promise<number>
    {
        const handler = pipeline(compressibleStreamingApp(), (next) => ({
            handle: async (request: Request) => compressResponse(request, await next.handle(request))
        }));
        const started = Date.now();
        const response = await handler.handle(
            new Request('http://local/stream', { headers: { 'accept-encoding': encoding } }));
        expect(response.headers.get('content-encoding')).toBe(encoding);

        const decoder = encoding === 'gzip' ? createGunzip() : createBrotliDecompress();
        let plain = '';
        const seen: { at: number | null } = { at: null };
        decoder.on('data', (chunk: Buffer) =>
        {
            plain += chunk.toString('utf8');
            if (seen.at === null && plain.includes('SHELL'))
            {
                seen.at = Date.now() - started;
            }
        });

        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        for (;;)
        {
            const next = await reader.read();
            if (next.done)
            {
                break;
            }
            decoder.write(Buffer.from(next.value));
            // Give the decoder a turn: without this the whole body is written before any
            // 'data' event fires and every encoding would look instant.
            await new Promise((resolve) => setImmediate(resolve));
            if (seen.at !== null)
            {
                break;
            }
        }
        decoder.destroy();
        await reader.cancel();
        return seen.at ?? Number.POSITIVE_INFINITY;
    }

    it('gzip: the shell is DECODABLE before the slow chunk', async () =>
    {
        expect(await firstDecodableAt('gzip')).toBeLessThan(SLOW_MS);
    });

    it('brotli: the shell is DECODABLE before the slow chunk', async () =>
    {
        expect(await firstDecodableAt('br')).toBeLessThan(SLOW_MS);
    });

    it('a BUFFERED response keeps the tighter encoding (no per-chunk flush)', async () =>
    {
        // A response that declares content-length is not streaming, so it must not pay the
        // flush cost. Same bytes, both ways: the buffered encoding has to be smaller.
        const body = '<p>panel</p>'.repeat(400);
        const app = new App();
        app.get('/buffered', () => new Response(body, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) }
        }));
        const app2 = new App();
        app2.get('/buffered', () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

        const encode = async (target: App): Promise<number> =>
        {
            const response = compressResponse(
                new Request('http://local/buffered', { headers: { 'accept-encoding': 'gzip' } }),
                await target.handle(new Request('http://local/buffered', { headers: { 'accept-encoding': 'gzip' } })));
            return (await response.arrayBuffer()).byteLength;
        };

        expect(await encode(app)).toBeLessThan(await encode(app2));
    });
});
