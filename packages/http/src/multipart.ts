/**
 * MODULE: http/multipart - a from-scratch multipart/form-data reader
 *
 * Parses the format browsers post when a form carries files (RFC 7578 over the RFC 2046
 * framing), with none of the incumbents' bolt-on baggage: limits are ON by default (total
 * bytes, part count, per-file bytes), unknown content types are a 415, and every malformation
 * is a typed 400 with a stable code - never a hang, never a crash.
 *
 * The parser works on BYTES end to end. File payloads are arbitrary binary; the moment a
 * multipart parser round-trips through strings it corrupts uploads (the classic latin1/utf8
 * mangling). Boundary scanning, header-block splitting, and payload slicing all operate on
 * Uint8Array; only field VALUES and header LINES are decoded as UTF-8 text.
 *
 * DESIGN: capped-buffer parsing. The body is read through readRaw's streaming limit first,
 * then parsed in one pass. Within a byte cap this is what the ecosystem's default memory
 * storage does anyway, with far less machinery to get wrong. The parsing core takes a plain
 * Uint8Array, so a future streaming mode (feeding parts to a sink as they arrive, for
 * uploads beyond memory) slots in behind the same part model without changing callers.
 */

import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './errors.ts';
import { readRaw } from './body.ts';

/** One file part of a multipart body. */
export interface UploadedFile
{
    /** The form field name this file was posted under. */
    name: string;

    /** The client-supplied filename, verbatim. UNTRUSTED: sanitize before touching a filesystem. */
    filename: string;

    /** The part's declared Content-Type (application/octet-stream when the client omits it). */
    contentType: string;

    /** The raw file bytes. */
    data: Uint8Array;
}

/** A parsed multipart/form-data body: text fields plus file parts. */
export interface MultipartBody
{
    /** Text fields, repeated names preserved - the same container readForm returns. */
    fields: URLSearchParams;

    /** File parts in posted order. */
    files: UploadedFile[];
}

export interface MultipartOptions
{
    /** Total body cap in bytes (default 8 MiB - form-with-files is legitimately larger than JSON). */
    limit?: number;

    /** Maximum number of parts, fields and files together (default 256). */
    maxParts?: number;

    /** Per-file cap in bytes (default: the total limit). */
    maxFileSize?: number;
}

const DEFAULT_MULTIPART_LIMIT = 8 * 1024 * 1024;
const DEFAULT_MAX_PARTS = 256;

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

/**
 * Reads and parses a multipart/form-data request. Throws UnsupportedMediaTypeError for other
 * content types, PayloadTooLargeError over the caps, and BadRequestError (code
 * 'malformed-multipart') for framing violations.
 */
export async function readMultipart(request: Request, options: MultipartOptions = {}): Promise<MultipartBody>
{
    const contentType = request.headers.get('content-type') ?? '';
    const boundary = boundaryOf(contentType);
    if (boundary === null)
    {
        throw new UnsupportedMediaTypeError(
            `Expected multipart/form-data with a boundary, got "${ contentType || '(none)' }".`);
    }

    const body = await readRaw(request, { limit: options.limit ?? DEFAULT_MULTIPART_LIMIT });
    return parseMultipart(body, boundary, {
        maxParts: options.maxParts ?? DEFAULT_MAX_PARTS,
        maxFileSize: options.maxFileSize ?? options.limit ?? DEFAULT_MULTIPART_LIMIT
    });
}

/**
 * Extracts the boundary parameter from a multipart/form-data content type, handling the
 * quoted and unquoted forms. Returns null when the type is not multipart/form-data or the
 * boundary is missing/oversized (RFC 2046 caps it at 70 characters).
 */
export function boundaryOf(contentType: string): string | null
{
    const semicolon = contentType.indexOf(';');
    const mediaType = (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
    if (mediaType !== 'multipart/form-data')
    {
        return null;
    }
    const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    const boundary = match?.[1] ?? match?.[2] ?? null;
    if (boundary === null || boundary.length === 0 || boundary.length > 70)
    {
        return null;
    }
    return boundary;
}

/** @internal First index of `needle` in `haystack` at or after `from`, or -1. Byte-exact. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number
{
    const limit = haystack.length - needle.length;
    outer: for (let i = from; i <= limit; i++)
    {
        for (let j = 0; j < needle.length; j++)
        {
            if (haystack[i + j] !== needle[j])
            {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}

/** @internal The buffered parsing core; pure, byte-exact, reusable by a future streaming mode. */
function parseMultipart(
    body: Uint8Array,
    boundary: string,
    limits: { maxParts: number; maxFileSize: number }
): MultipartBody
{
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    // Between parts every boundary appears as CRLF + "--" + boundary; the FIRST boundary has
    // no preceding CRLF (nothing precedes it but optional preamble). Searching for the
    // un-prefixed form and then consuming the line keeps one search covering both cases.
    const delimiter = encoder.encode(`--${ boundary }`);

    const fields = new URLSearchParams();
    const files: UploadedFile[] = [];

    let cursor = indexOfBytes(body, delimiter, 0);
    if (cursor === -1)
    {
        throw new BadRequestError('The multipart body contains no boundary.', { code: 'malformed-multipart' });
    }

    let parts = 0;
    for (;;)
    {
        cursor += delimiter.length;

        // "--" after the boundary marks the terminal delimiter; anything after is epilogue.
        if (body[cursor] === 45 && body[cursor + 1] === 45)
        {
            return { fields, files };
        }
        // Otherwise the boundary line must end with CRLF.
        if (body[cursor] !== 13 || body[cursor + 1] !== 10)
        {
            throw new BadRequestError('Malformed boundary line in multipart body.', { code: 'malformed-multipart' });
        }
        cursor += 2;

        if (++parts > limits.maxParts)
        {
            throw new BadRequestError(
                `The multipart body exceeds ${ limits.maxParts } parts.`, { code: 'too-many-parts' });
        }

        // Header block: CRLF-separated lines terminated by an empty line.
        const headerEnd = indexOfBytes(body, HEADER_END, cursor);
        if (headerEnd === -1)
        {
            throw new BadRequestError('A multipart part is missing its header terminator.', { code: 'malformed-multipart' });
        }
        const headerText = decoder.decode(body.subarray(cursor, headerEnd));
        const headers = parsePartHeaders(headerText);
        cursor = headerEnd + HEADER_END.length;

        // Payload: everything up to the CRLF that precedes the next delimiter.
        const nextDelimiter = indexOfBytes(body, delimiter, cursor);
        if (nextDelimiter === -1)
        {
            throw new BadRequestError('The multipart body is missing its closing boundary.', { code: 'malformed-multipart' });
        }
        const payloadEnd = nextDelimiter - CRLF.length;
        if (payloadEnd < cursor || indexOfBytes(body, CRLF, payloadEnd) !== payloadEnd)
        {
            throw new BadRequestError('A multipart payload is not CRLF-delimited from its boundary.', { code: 'malformed-multipart' });
        }
        const payload = body.subarray(cursor, payloadEnd);

        if (headers.filename !== null)
        {
            if (payload.byteLength > limits.maxFileSize)
            {
                throw new PayloadTooLargeError(
                    `File "${ headers.filename }" exceeds the ${ limits.maxFileSize }-byte per-file limit.`);
            }
            files.push({
                name: headers.name,
                filename: headers.filename,
                contentType: headers.contentType ?? 'application/octet-stream',
                data: payload.slice() // detach from the request buffer so it can be GC'd
            });
        }
        else
        {
            fields.append(headers.name, decoder.decode(payload));
        }

        cursor = nextDelimiter;
    }
}

/** @internal Parses one part's header block into what RFC 7578 says matters. */
function parsePartHeaders(block: string): { name: string; filename: string | null; contentType: string | null }
{
    let name: string | null = null;
    let filename: string | null = null;
    let contentType: string | null = null;

    for (const line of block.split('\r\n'))
    {
        const colon = line.indexOf(':');
        if (colon === -1)
        {
            continue;
        }
        const header = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (header === 'content-type')
        {
            contentType = value;
        }
        else if (header === 'content-disposition')
        {
            if (!/^form-data\b/i.test(value))
            {
                throw new BadRequestError(
                    'A multipart part is not form-data.', { code: 'malformed-multipart' });
            }
            name = dispositionParam(value, 'name');
            filename = dispositionParam(value, 'filename');
        }
    }

    if (name === null)
    {
        throw new BadRequestError(
            'A multipart part is missing its field name.', { code: 'malformed-multipart' });
    }
    return { name, filename, contentType };
}

/**
 * @internal One Content-Disposition parameter. Browsers percent-escape quotes and newlines
 * inside quoted strings (the WHATWG multipart serialization), so a simple quoted scan is
 * exact for real clients; the unquoted token form is accepted for non-browser peers.
 */
function dispositionParam(disposition: string, param: string): string | null
{
    const pattern = new RegExp(`;\\s*${ param }=(?:"([^"]*)"|([^;\\s]+))`, 'i');
    const match = pattern.exec(disposition);
    if (match === null)
    {
        return null;
    }
    return match[1] ?? match[2] ?? null;
}
