/**
 * MODULE: http/compress - negotiated response compression via node:zlib
 *
 * `compressResponse(request, response)` returns the response compressed with the best
 * encoding the client accepts (brotli > gzip > deflate), or the response untouched when
 * compression would be wrong:
 *
 *   - non-compressible types (images, video, fonts, archives - already entropy-coded;
 *     recompressing burns CPU to make them larger);
 *   - bodies under the threshold (headers dwarf the saving; default 1 KiB);
 *   - already-encoded responses, 204/304s, and HEAD-stripped bodies;
 *   - responses that carry `Cache-Control: no-transform`.
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

/** Media types worth compressing: text in any costume, plus the text-like applications. */
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
        || type === 'application/json'
        || type === 'application/javascript'
        || type === 'application/xml'
        || type === 'application/wasm'
        || type === 'image/svg+xml'
        || type.endsWith('+json')
        || type.endsWith('+xml');
}

/** @internal The `q` weight of one Accept-Encoding entry, from its parameters (default 1). */
function qualityOf(parameters: string[]): number
{
    for (const parameter of parameters)
    {
        const equals = parameter.indexOf('=');
        if (parameter.slice(0, equals === -1 ? undefined : equals).trim().toLowerCase() !== 'q')
        {
            continue;
        }
        const quality = Number(parameter.slice(equals + 1).trim());
        // An unparseable weight counts as a refusal: identity is always acceptable, so
        // guessing "acceptable" is the only reading that can put an undecodable body on the wire.
        return Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0;
    }
    return 1;
}

/**
 * @internal The client's pick among what we implement, by the Accept-Encoding header.
 * `q=0` is a REFUSAL, not a listing (RFC 9110 12.5.3), so a coding named only to reject it is
 * never used. `*` stands for the codings the client did not name and authorizes gzip - the
 * universally safe pick - never brotli, which a client that wanted it would have named.
 */
function negotiate(acceptEncoding: string): 'br' | 'gzip' | 'deflate' | null
{
    const quality = new Map<string, number>();
    for (const entry of acceptEncoding.split(','))
    {
        const semicolon = entry.indexOf(';');
        const coding = entry.slice(0, semicolon === -1 ? undefined : semicolon).trim().toLowerCase();
        if (coding === '')
        {
            continue;
        }
        const weight = semicolon === -1 ? 1 : qualityOf(entry.slice(semicolon + 1).split(';'));
        // A coding listed twice keeps its LOWEST weight: a refusal anywhere in the field is
        // still a refusal.
        const previous = quality.get(coding);
        quality.set(coding, previous === undefined ? weight : Math.min(previous, weight));
    }

    const wildcard = quality.get('*') ?? 0;
    let best: 'br' | 'gzip' | 'deflate' | null = null;
    let bestQuality = 0;
    for (const candidate of ['br', 'gzip', 'deflate'] as const)
    {
        const offered = quality.get(candidate) ?? (candidate === 'gzip' ? wildcard : 0);
        if (offered > bestQuality)
        {
            best = candidate;
            bestQuality = offered;
        }
    }
    return best;
}

/**
 * @internal The encoded representation's validator. RFC 9110 8.8.3: representations whose
 * bytes differ must not share a strong ETag, or a cache revalidates its stored gzip body
 * against the identity tag and then serves gzip bytes as plain text.
 */
function encodedEtag(etag: string, encoding: string): string
{
    const weak = etag.startsWith('W/');
    const value = weak ? etag.slice(2) : etag;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    {
        return `${ weak ? 'W/' : '' }"${ value.slice(1, -1) }-${ encoding }"`;
    }
    return `${ etag }-${ encoding }`;
}

/**
 * Options for negotiated response compression (br/gzip/deflate): the size floor below which
 * compression costs more than it saves, and the media types worth compressing. Event streams
 * and already-compressed types are skipped regardless.
 */
export interface CompressOptions
{
    /** Bodies below this byte count (per Content-Length, when known) pass through. Default 1024. */
    threshold?: number;
}

/**
 * Returns `response` compressed for `request`, or `response` itself when compression does
 * not apply. Always safe to call unconditionally on the way out.
 */
export function compressResponse(request: Request, response: Response, options: CompressOptions = {}): Response
{
    const threshold = options.threshold ?? 1024;

    if (response.body === null
        || response.status === 204
        || response.status === 206 // a byte range refers to the UNENCODED representation; compressing it breaks resume math
        || response.status === 304
        || response.headers.has('content-encoding'))
    {
        return response;
    }
    if (!isCompressible(response.headers.get('content-type') ?? ''))
    {
        return response;
    }
    // `no-transform` forbids exactly this (RFC 9110 5.2.2.6): whoever set it needs the bytes
    // delivered as written - a signed payload, a byte-exact contract.
    const cacheControl = (response.headers.get('cache-control') ?? '').toLowerCase();
    if (cacheControl.split(',').some((directive) => directive.trim() === 'no-transform'))
    {
        return response;
    }
    // Only an EXPLICIT Content-Length can prove the body is too small to bother with;
    // an absent header (Number(null) is 0, a classic trap) means "unknown - compress".
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) < threshold)
    {
        return response;
    }

    const encoding = negotiate(request.headers.get('accept-encoding') ?? '');
    if (encoding === null)
    {
        return response;
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
    const streaming = response.headers.get('content-length') === null;
    let transform: Transform;
    if (encoding === 'br')
    {
        // TEXT mode tunes brotli's context modeling for what we compress (see isCompressible).
        transform = createBrotliCompress({
            params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT },
            ...(streaming ? { flush: constants.BROTLI_OPERATION_FLUSH } : {})
        });
    }
    else if (encoding === 'gzip')
    {
        transform = createGzip(streaming ? { flush: constants.Z_SYNC_FLUSH } : {});
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
    const compressed = Readable.toWeb(transform) as ReadableStream<Uint8Array>;

    const headers = new Headers(response.headers);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    // Range offsets name bytes of the IDENTITY representation; the encoded stream has none.
    headers.delete('accept-ranges');
    headers.append('vary', 'accept-encoding');
    const etag = response.headers.get('etag');
    if (etag !== null)
    {
        headers.set('etag', encodedEtag(etag, encoding));
    }

    return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
