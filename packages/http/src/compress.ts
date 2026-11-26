/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Negotiated response compression via node:zlib.
 *
 * `compressResponse(request, response)` returns the response compressed with the best
 * encoding the client accepts (brotli > gzip > deflate), or the response untouched when
 * compression would be wrong:
 *
 *   - formats such as WOFF2, PNG and compressed audio or video that already encode compactly;
 *   - bodies under the threshold (headers dwarf the saving; default 1 KiB);
 *   - already-encoded responses, byte ranges and bodyless representations;
 *   - responses that carry `Cache-Control: no-transform`.
 *
 * HEAD and a framework-produced 304 can describe a known GET representation without running
 * the encoder. A sparse upstream 304 retains its original coding and validator.
 *
 * Compression STREAMS: the body pipes through the zlib transform, so a large SSR document
 * compresses as it is produced. Piping is not enough on its own, though - the compressor holds
 * bytes in its window, so a streamed response also flushes per chunk or the client cannot
 * DECODE the shell until the last chunk arrives (measured: brotli held everything from 3 KB to
 * 256 KB). A response declaring Content-Length is not streaming and keeps the tighter encoding.
 *
 * Content-Length is dropped (the encoded size is unknown ahead of time) and
 * `Vary: Accept-Encoding` is appended so caches key correctly - forgetting Vary is how one
 * client's gzip lands on another's curl. The encoded body is a DIFFERENT representation, so it
 * gets its own ETag and drops Accept-Ranges.
 */

import { constants, createBrotliCompress, createDeflate, createGzip } from 'node:zlib';
import { Readable, pipeline, type Transform } from 'node:stream';

import { hasRepresentationHeaders, headResponse, matchesEtag } from './conditional.ts';
import { negotiateEncodings } from './content-coding.ts';
import { appendVary, edge, withResponseHeaders, type EdgeMiddleware } from './edge.ts';
import { PayloadResponse } from './payload.ts';
import { markClientFault } from './errors.ts';
import { webStreamOf } from './web-stream.ts';

/** Exact media types eligible alongside text and the JSON/XML structured syntax suffixes. */
const compressibleTypes = new Set([
    'application/javascript', 'application/json', 'application/wasm', 'application/xml',
    'font/otf', 'font/ttf', 'image/bmp', 'model/gltf-binary'
]);

function isCompressible(contentType: string): boolean
{
    const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    // Event streams are realtime: zlib's block buffering would hold events hostage until a
    // flush boundary, so they are exempt despite the text/ prefix.
    if (type === 'text/event-stream')
    {
        return false;
    }
    return type.startsWith('text/')
        || type.endsWith('+json')
        || type.endsWith('+xml')
        || compressibleTypes.has(type);
}

/** Quality and size controls for on-the-fly response compression. */
export interface CompressOptions
{
    /** Bodies below this byte count (per Content-Length, when known) pass through. Default 1024. */
    threshold?: number;

    /** Brotli compression quality, an integer from 0 to 11. Default 5. */
    brotliQuality?: number;

    /** Gzip compression level, an integer from -1 (zlib default) to 9. Default -1. */
    gzipLevel?: number;
}

function validateOptions(options: CompressOptions): void
{
    const { brotliQuality, gzipLevel } = options;
    if (brotliQuality !== undefined && (!Number.isInteger(brotliQuality) || brotliQuality < 0 || brotliQuality > 11))
    {
        throw new RangeError('brotliQuality must be an integer from 0 to 11');
    }
    if (gzipLevel !== undefined && (!Number.isInteger(gzipLevel) || gzipLevel < -1 || gzipLevel > 9))
    {
        throw new RangeError('gzipLevel must be an integer from -1 to 9');
    }
}

/** Negotiate compression around the public HTTP handler, including its HEAD responses. */
export function compress(options: CompressOptions = {}): EdgeMiddleware
{
    const settings = { ...options };
    validateOptions(settings);
    return edge(next => ({
        handle: async request => compressFor(request, await next.handle(request), settings)
    }));
}

/**
 * Returns the representation negotiated for the request. Responses eligible for compression
 * vary by Accept-Encoding, including when the selected representation is identity.
 */
export function compressResponse(request: Request, response: Response, options: CompressOptions = {}): Response
{
    validateOptions(options);
    return compressFor(request, response, options);
}

/** Discard a representation that the client already has or only requested metadata for. */
function discardBody(response: Response): void
{
    // A kernel payload is already buffered. Reading its body would construct a stream just
    // to cancel it. A native producer may hold a file or an iterator and must be cancelled.
    if (!(response instanceof PayloadResponse))
    {
        // The comparison is synchronous. A producer already errored or closed has no more
        // bytes to release, and its cancellation rejection has no downstream body reader.
        void response.body?.cancel().catch(() => undefined);
    }
}

function compressFor(request: Request, response: Response, options: CompressOptions): Response
{
    const head = request.method === 'HEAD';
    if (head && (response instanceof PayloadResponse || response.body !== null))
    {
        discardBody(response);
        response = headResponse(response);
    }

    const status = response.status;
    const type = response.headers.get('content-type');
    if (status === 204 || status === 205 || status === 206 || status === 416
        || request.headers.has('range') || response.headers.has('content-encoding')
        || (type === null ? status !== 304 : !isCompressible(type)))
    {
        return response;
    }
    const cacheControl = (response.headers.get('cache-control') ?? '').toLowerCase();
    if (cacheControl.split(',').some(directive => directive.trim() === 'no-transform'))
    {
        return response;
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) < (options.threshold ?? 1024))
    {
        return response;
    }
    // A HEAD handler can omit opening its GET stream and declare its positive byte length.
    // The framework can also attest to a suppressed stream whose length was unknown.
    const headDescribesBody = head && (hasRepresentationHeaders(response)
        || (declared !== null && /^0*[1-9]\d*$/.test(declared)));
    // Reading a buffered payload's body would allocate a stream before encoding starts.
    if (status !== 304 && !(response instanceof PayloadResponse) && response.body === null && !headDescribesBody)
    {
        return response;
    }

    const vary = appendVary(response.headers.get('vary'), 'accept-encoding');
    // External 304s may legally omit the GET's coding, size or cache policy. Keep their
    // validator and add conservative Vary when the visible headers allow negotiation.
    const [encoding] = status === 304 && (!hasRepresentationHeaders(response) || declared === null || type === null)
        ? []
        : negotiateEncodings(request.headers.get('accept-encoding') ?? '');
    const ifNoneMatch = request.headers.get('if-none-match');
    // Codec quality and streaming flush boundaries can change the encoded bytes while
    // preserving the content. Retain the coding suffix with a weak validator.
    const entity = /^(?:W\/)?"([^"]*)"$/.exec(response.headers.get('etag') ?? '');
    const tag = encoding === undefined || entity === null ? null : `W/"${ entity[1] }-${ encoding }"`;
    const codedMatch = tag !== null && matchesEtag(ifNoneMatch, tag);
    // An early 304 against an explicit identity validator revalidates that copy. A date,
    // wildcard or list containing the negotiated tag describes the selected GET.
    if (encoding === undefined || (status === 304 && ifNoneMatch !== null && ifNoneMatch.trim() !== '*' && !codedMatch))
    {
        return response.headers.get('vary') === vary ? response : withResponseHeaders(response, { vary });
    }

    const headers = new Headers(response.headers);
    headers.set('vary', vary);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    headers.delete('accept-ranges');
    if (tag !== null)
    {
        headers.set('etag', tag);
    }
    else
    {
        // A malformed producer tag cannot validate a transformed representation.
        headers.delete('etag');
    }
    if (status === 200 && (head || request.method === 'GET') && codedMatch)
    {
        discardBody(response);
        return new Response(null, { status: 304, headers });
    }
    if (head || status === 304)
    {
        return new Response(null, { status, statusText: response.statusText, headers });
    }

    // A STREAMED response needs a flush per chunk or compression silently defeats streaming.
    //
    // The compressor holds bytes in its window until the window fills or the stream ends, so
    // although this pipes rather than buffers, a CLIENT cannot DECODE anything until enough
    // bytes accumulate. Measured on a shell followed by a 300 ms hold: brotli produced no
    // decodable content before the hold in ANY size tested, and gzip only when the shell was
    // both large and incompressible. So the shell arrived on the wire immediately and still
    // painted late - the exact regression streaming exists to avoid, invisible to every header.
    //
    // Flushing costs ratio, so it is spent only where it buys something: a response with no
    // content-length is the streaming one. A buffered response keeps the tighter encoding.
    const streaming = declared === null;
    let transform: Transform;
    if (encoding === 'br')
    {
        transform = createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: options.brotliQuality ?? 5
            },
            ...(streaming ? { flush: constants.BROTLI_OPERATION_FLUSH } : {})
        });
    }
    else if (encoding === 'gzip')
    {
        transform = createGzip({ level: options.gzipLevel ?? -1, ...(streaming ? { flush: constants.Z_SYNC_FLUSH } : {}) });
    }
    else
    {
        transform = createDeflate(streaming ? { flush: constants.Z_SYNC_FLUSH } : {});
    }

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    // pipeline(), never source.pipe(transform): pipe forwards NEITHER direction's failure. A
    // source error would re-emit with no listener attached (an unhandled 'error' event kills
    // the process), and a reader cancel would never reach the source (one leaked fd per
    // aborted download). The callback is what keeps pipeline from throwing on error - both
    // ends already carry the failure, and the web reader is where it surfaces.
    pipeline(source, transform, () => undefined);
    const compressed = webStreamOf(transform, {
        // A compressed body that stops short means the PEER went away, which the error path must
        // not read as this server failing.
        prematureClose: () =>
        {
            const premature = new Error('compressResponse: the compressed stream closed before it ended.');
            (premature as { code?: string }).code = 'ERR_STREAM_PREMATURE_CLOSE';
            return markClientFault(premature);
        }
    });

    return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
