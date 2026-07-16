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
 *   - already-encoded responses, 204/304s, and HEAD-stripped bodies.
 *
 * Compression STREAMS: the body pipes through the zlib transform, so a large SSR document
 * compresses as it is produced. Content-Length is dropped (the encoded size is unknown ahead
 * of time) and `Vary: Accept-Encoding` is appended so caches key correctly - forgetting Vary
 * is how one client's gzip lands on another's curl.
 */

import { constants, createBrotliCompress, createDeflate, createGzip } from 'node:zlib';
import { Readable, type Transform } from 'node:stream';

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

/** @internal The client's pick among what we implement, by the Accept-Encoding header. */
function negotiate(acceptEncoding: string): 'br' | 'gzip' | 'deflate' | null
{
    const accepted = new Set(acceptEncoding.split(',').map((part) => (part.split(';')[0] ?? '').trim().toLowerCase()));
    if (accepted.has('br'))
    {
        return 'br';
    }
    if (accepted.has('gzip') || accepted.has('*'))
    {
        return 'gzip';
    }
    if (accepted.has('deflate'))
    {
        return 'deflate';
    }
    return null;
}

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
        || response.status === 304
        || response.headers.has('content-encoding'))
    {
        return response;
    }
    if (!isCompressible(response.headers.get('content-type') ?? ''))
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

    let transform: Transform;
    if (encoding === 'br')
    {
        // TEXT mode tunes brotli's context modeling for what we compress (see isCompressible).
        transform = createBrotliCompress({ params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT } });
    }
    else if (encoding === 'gzip')
    {
        transform = createGzip();
    }
    else
    {
        transform = createDeflate();
    }

    const compressed = Readable.toWeb(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(transform)
    ) as ReadableStream<Uint8Array>;

    const headers = new Headers(response.headers);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    headers.append('vary', 'accept-encoding');

    return new Response(compressed, { status: response.status, statusText: response.statusText, headers });
}
