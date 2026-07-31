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
 * TWO MODES, one part model:
 *
 *   - readMultipart: capped-buffer parsing. The body is read through readRaw's streaming
 *     limit first, then parsed in one pass. Within a byte cap this is what the ecosystem's
 *     default memory storage does anyway, with far less machinery to get wrong.
 *   - streamMultipart: the pull-based iterator for uploads beyond memory. Parts arrive in
 *     posted order; each file's payload is a ReadableStream the consumer pipes to its own
 *     sink (disk, object storage) while the request is still uploading. Single pass over
 *     the socket: advancing the iterator finishes the current part.
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

/**
 * Caps for {@link readMultipart} - three independent axes (total bytes, part count, per-file
 * bytes), each ON by default. A cap crossing aborts the parse mid-stream as a 413; nothing is
 * buffered past the limit.
 */
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
    const first = needle[0];
    if (first === undefined)
    {
        return from;
    }
    // The first-byte test guards the compare loop. Every needle here starts with a byte the
    // client does not choose (CR), so no boundary-plus-payload pair it picks can keep the
    // inner loop running at every offset - which is what turns this scan quadratic.
    const limit = haystack.length - needle.length;
    outer: for (let i = from; i <= limit; i++)
    {
        if (haystack[i] !== first)
        {
            continue;
        }
        for (let j = 1; j < needle.length; j++)
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

/** @internal Does `needle` sit at exactly `at` in `haystack`? */
function matchesAt(haystack: Uint8Array, needle: Uint8Array, at: number): boolean
{
    if (at + needle.length > haystack.length)
    {
        return false;
    }
    for (let i = 0; i < needle.length; i++)
    {
        if (haystack[at + i] !== needle[i])
        {
            return false;
        }
    }
    return true;
}

/** @internal The buffered parsing core; pure and byte-exact ({@link streamMultipart} is the incremental twin). */
function parseMultipart(
    body: Uint8Array,
    boundary: string,
    limits: { maxParts: number; maxFileSize: number }
): MultipartBody
{
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    // Every boundary but the first appears as CRLF + "--" + boundary, and the CRLF stays IN
    // the delimiter: a client picks the boundary AND the payload bytes, and an un-prefixed
    // needle (`--` + 70 dashes) against a body of dashes makes every single offset compare the
    // whole boundary - seconds of blocked event loop per request. The first boundary, which has
    // nothing but optional preamble before it, is matched once against the un-prefixed form.
    const delimiter = encoder.encode(`\r\n--${ boundary }`);
    const opening = delimiter.subarray(CRLF.length);

    const fields = new URLSearchParams();
    const files: UploadedFile[] = [];

    let cursor: number;
    if (matchesAt(body, opening, 0))
    {
        cursor = opening.length;
    }
    else
    {
        const first = indexOfBytes(body, delimiter, 0);
        if (first === -1)
        {
            throw new BadRequestError('The multipart body contains no boundary.', { code: 'malformed-multipart' });
        }
        cursor = first + delimiter.length;
    }

    let parts = 0;
    for (;;)
    {
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

        // Payload: everything up to the next delimiter, whose leading CRLF closes it.
        const nextDelimiter = indexOfBytes(body, delimiter, cursor);
        if (nextDelimiter === -1)
        {
            throw new BadRequestError('The multipart body is missing its closing boundary.', { code: 'malformed-multipart' });
        }
        const payload = body.subarray(cursor, nextDelimiter);

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

        cursor = nextDelimiter + delimiter.length;
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
            const params = dispositionParams(value);
            name = params.get('name') ?? null;
            // RFC 8187 gives `filename*` precedence over `filename`, and its mere PRESENCE
            // makes the part a file: classified as a text field it would face neither the
            // per-file cap nor byte preservation.
            filename = extendedFilename(params.get('filename*')) ?? params.get('filename') ?? null;
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
 * @internal Every Content-Disposition parameter, keyed by lowercased name. The split happens
 * on semicolons OUTSIDE quoted strings only: a scan that ignores the quotes lets
 * `name="note; filename=evil.exe"` smuggle a filename (and with it the file classification)
 * out of a value that is entirely one field NAME. Browsers percent-escape quotes and newlines
 * inside quoted strings (the WHATWG multipart serialization), so the value is taken verbatim;
 * the unquoted token form is accepted for non-browser peers.
 */
function dispositionParams(disposition: string): Map<string, string>
{
    const params = new Map<string, string>();
    let start = 0;
    let quoted = false;
    let first = true;
    for (let i = 0; i <= disposition.length; i++)
    {
        const char = disposition[i];
        if (char === '"')
        {
            quoted = !quoted;
            continue;
        }
        if (char !== undefined && (char !== ';' || quoted))
        {
            continue;
        }
        const segment = disposition.slice(start, i);
        start = i + 1;
        if (first)
        {
            first = false; // the disposition type itself ("form-data"), not a parameter
            continue;
        }
        const equals = segment.indexOf('=');
        if (equals === -1)
        {
            continue;
        }
        const key = segment.slice(0, equals).trim().toLowerCase();
        const raw = segment.slice(equals + 1).trim();
        const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        if (!params.has(key))
        {
            params.set(key, value);
        }
    }
    return params;
}

/**
 * @internal The RFC 8187 extended value: `charset'language'percent-encoded`. Undecodable input
 * still returns a string rather than null - the part is a FILE either way, and demoting it to a
 * text field is what skips the per-file cap and mangles binary through a UTF-8 decode.
 */
function extendedFilename(value: string | undefined): string | null
{
    if (value === undefined)
    {
        return null;
    }
    const match = /^([^']*)'[^']*'(.*)$/.exec(value);
    if (match === null)
    {
        return value;
    }
    const [, charset, encoded] = match;
    try
    {
        if ((charset ?? '').toLowerCase() === 'iso-8859-1')
        {
            return (encoded ?? '').replace(/%([0-9A-Fa-f]{2})/g,
                (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
        }
        return decodeURIComponent(encoded ?? '');
    }
    catch
    {
        return encoded ?? value;
    }
}

/** One part of a multipart body, delivered incrementally by {@link streamMultipart}. */
export interface MultipartPartStream
{
    /** The form field name this part was posted under. */
    name: string;

    /** The client-supplied filename, or null for a text field. UNTRUSTED: sanitize before touching a filesystem. */
    filename: string | null;

    /** The part's declared Content-Type (application/octet-stream when the client omits it). */
    contentType: string;

    /**
     * The payload bytes as they arrive off the socket. Single-pass: consume (or skip) this
     * stream BEFORE advancing the iterator - advancing discards whatever remains unread.
     */
    stream: ReadableStream<Uint8Array>;

    /**
     * Buffers the whole payload - the per-part sink for parts known to be small. Guarded by
     * a cap (default 8 MiB) because buffering is exactly what streaming mode exists to avoid.
     */
    bytes(limit?: number): Promise<Uint8Array>;

    /** The payload as UTF-8 text, same cap as {@link MultipartPartStream.bytes}. */
    text(limit?: number): Promise<string>;
}

/**
 * Caps for {@link streamMultipart}, the pull-based twin: per-part limits only, because the
 * whole point is that file payloads stream to their sink instead of buffering - total size is
 * the sink's business.
 */
export interface StreamMultipartOptions
{
    /** Maximum number of parts, fields and files together (default 256). */
    maxParts?: number;

    /**
     * Per-part payload cap in bytes. UNLIMITED by default - the consumer's sink governs in
     * streaming mode, and a surprise default cap would fail exactly the large uploads this
     * mode exists for. Set it when the route knows its ceiling.
     */
    maxPartBytes?: number;
}

/** @internal Part header blocks may not exceed this (a header block is human-scale metadata). */
const MAX_PART_HEADER_BYTES = 16 * 1024;

/** @internal Incremental byte cursor over the request body: one buffer, one reader, one pass. */
class ByteFeed
{
    readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
    public buffer: Uint8Array;
    public eof = false;

    constructor(reader: ReadableStreamDefaultReader<Uint8Array>, primed: Uint8Array)
    {
        this.#reader = reader;
        this.buffer = primed;
    }

    /** Appends the next chunk to the buffer; false when the body is exhausted. */
    public async fill(): Promise<boolean>
    {
        if (this.eof)
        {
            return false;
        }
        const { done, value } = await this.#reader.read();
        if (done)
        {
            this.eof = true;
            return false;
        }
        if (this.buffer.byteLength === 0)
        {
            this.buffer = value;
            return true;
        }
        const joined = new Uint8Array(this.buffer.byteLength + value.byteLength);
        joined.set(this.buffer, 0);
        joined.set(value, this.buffer.byteLength);
        this.buffer = joined;
        return true;
    }

    /** Drops `count` bytes off the front. */
    public consume(count: number): void
    {
        this.buffer = this.buffer.subarray(count);
    }

    /** Stops reading the underlying body (terminal delimiter or fatal error). */
    public async cancel(): Promise<void>
    {
        this.eof = true;
        await this.#reader.cancel().catch(() => undefined);
    }
}

/**
 * Streams a multipart/form-data request part by part - the beyond-memory mode. Same
 * validation posture as {@link readMultipart}: wrong content type is a 415, framing
 * violations are typed 400s, part-count and header caps hold. Payload SIZE is the
 * consumer's to govern (or {@link StreamMultipartOptions.maxPartBytes}).
 *
 * ```ts
 * for await (const part of streamMultipart(context.request))
 * {
 *     if (part.filename !== null) { await part.stream.pipeTo(diskSink(part)); }
 *     else { fields.append(part.name, await part.text()); }
 * }
 * ```
 */
export async function* streamMultipart(
    request: Request, options: StreamMultipartOptions = {}
): AsyncGenerator<MultipartPartStream, void, undefined>
{
    const contentType = request.headers.get('content-type') ?? '';
    const boundary = boundaryOf(contentType);
    if (boundary === null)
    {
        throw new UnsupportedMediaTypeError(
            `Expected multipart/form-data with a boundary, got "${ contentType || '(none)' }".`);
    }
    if (request.body === null)
    {
        throw new BadRequestError('The multipart body contains no boundary.', { code: 'malformed-multipart' });
    }

    const maxParts = options.maxParts ?? DEFAULT_MAX_PARTS;
    const maxPartBytes = options.maxPartBytes ?? Infinity;
    const encoder = new TextEncoder();

    // The uniform delimiter is CRLF + "--" + boundary. Priming the buffer with a virtual
    // CRLF makes the FIRST boundary (which has none preceding it) match the same search;
    // the synthetic bytes land in the preamble, which RFC 2046 says to discard anyway.
    const delimiter = encoder.encode(`\r\n--${ boundary }`);
    const feed = new ByteFeed(request.body.getReader(), CRLF.slice());

    // try/finally so EVERY exit - terminal delimiter, thrown framing error, or the
    // consumer breaking out of the for-await loop early - releases the request body reader.
    try
    {
        yield* streamParts(feed, delimiter, maxParts, maxPartBytes);
    }
    finally
    {
        await feed.cancel();
    }
}

/** @internal The part loop behind {@link streamMultipart}; the caller owns reader cleanup. */
async function* streamParts(
    feed: ByteFeed, delimiter: Uint8Array, maxParts: number, maxPartBytes: number
): AsyncGenerator<MultipartPartStream, void, undefined>
{
    const decoder = new TextDecoder();

    // Preamble: discard up to the first delimiter, retaining only a possible partial match.
    for (;;)
    {
        const at = indexOfBytes(feed.buffer, delimiter, 0);
        if (at !== -1)
        {
            feed.consume(at);
            break;
        }
        feed.consume(Math.max(0, feed.buffer.byteLength - (delimiter.length - 1)));
        if (!await feed.fill())
        {
            throw new BadRequestError('The multipart body contains no boundary.', { code: 'malformed-multipart' });
        }
    }

    let parts = 0;
    for (;;)
    {
        // The buffer starts at a delimiter. Two bytes decide: "--" ends the body, CRLF
        // opens the next part's header block.
        while (feed.buffer.byteLength < delimiter.length + 2)
        {
            if (!await feed.fill())
            {
                throw new BadRequestError('Malformed boundary line in multipart body.', { code: 'malformed-multipart' });
            }
        }
        feed.consume(delimiter.length);
        if (feed.buffer[0] === 45 && feed.buffer[1] === 45)
        {
            await feed.cancel();
            return;
        }
        if (feed.buffer[0] !== 13 || feed.buffer[1] !== 10)
        {
            throw new BadRequestError('Malformed boundary line in multipart body.', { code: 'malformed-multipart' });
        }
        feed.consume(2);

        if (++parts > maxParts)
        {
            await feed.cancel();
            throw new BadRequestError(`The multipart body exceeds ${ maxParts } parts.`, { code: 'too-many-parts' });
        }

        // Header block, capped: accumulate until the empty line.
        let headerEnd = indexOfBytes(feed.buffer, HEADER_END, 0);
        while (headerEnd === -1)
        {
            if (feed.buffer.byteLength > MAX_PART_HEADER_BYTES)
            {
                await feed.cancel();
                throw new BadRequestError('A multipart part header block is too large.', { code: 'malformed-multipart' });
            }
            if (!await feed.fill())
            {
                throw new BadRequestError('A multipart part is missing its header terminator.', { code: 'malformed-multipart' });
            }
            headerEnd = indexOfBytes(feed.buffer, HEADER_END, 0);
        }
        const headers = parsePartHeaders(decoder.decode(feed.buffer.subarray(0, headerEnd)));
        feed.consume(headerEnd + HEADER_END.length);

        // Payload: bytes up to the next delimiter, surfaced through a pull-based stream.
        // `emit` hands the next span to whoever is consuming (the part's stream, or the
        // discard path when the iterator advances past an unread part).
        let partDone = false;
        let partBytes = 0;
        const nextSpan = async (emit: (chunk: Uint8Array) => void): Promise<boolean> =>
        {
            for (;;)
            {
                const at = indexOfBytes(feed.buffer, delimiter, 0);
                if (at !== -1)
                {
                    if (at > 0)
                    {
                        emit(feed.buffer.slice(0, at));
                        feed.consume(at);
                    }
                    partDone = true;
                    return true;
                }
                const safe = feed.buffer.byteLength - (delimiter.length - 1);
                if (safe > 0)
                {
                    emit(feed.buffer.slice(0, safe));
                    feed.consume(safe);
                    return false;
                }
                if (!await feed.fill())
                {
                    await feed.cancel();
                    throw new BadRequestError('The multipart body is missing its closing boundary.', { code: 'malformed-multipart' });
                }
            }
        };
        const guard = (chunk: Uint8Array): Uint8Array =>
        {
            partBytes += chunk.byteLength;
            if (partBytes > maxPartBytes)
            {
                throw new PayloadTooLargeError(
                    `Part "${ headers.name }" exceeds the ${ maxPartBytes }-byte per-part limit.`);
            }
            return chunk;
        };

        const stream = new ReadableStream<Uint8Array>({
            async pull(controller): Promise<void>
            {
                if (partDone)
                {
                    controller.close();
                    return;
                }
                try
                {
                    if (await nextSpan((chunk) => controller.enqueue(guard(chunk))))
                    {
                        controller.close();
                    }
                }
                catch (error)
                {
                    await feed.cancel();
                    controller.error(error);
                    throw error;
                }
            }
        });

        const bytes = async (limit?: number): Promise<Uint8Array> =>
        {
            const cap = limit ?? DEFAULT_MULTIPART_LIMIT;
            const collected: Uint8Array[] = [];
            let total = 0;
            const reader = stream.getReader();
            for (;;)
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    break;
                }
                total += value.byteLength;
                if (total > cap)
                {
                    await feed.cancel();
                    throw new PayloadTooLargeError(`Part "${ headers.name }" exceeds the ${ cap }-byte buffering limit.`);
                }
                collected.push(value);
            }
            const joined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of collected)
            {
                joined.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return joined;
        };

        yield {
            name: headers.name,
            filename: headers.filename,
            contentType: headers.contentType ?? 'application/octet-stream',
            stream,
            bytes,
            text: async (limit?: number) => decoder.decode(await bytes(limit))
        };

        // Single-pass discipline: whatever the consumer left unread is discarded here so
        // the iterator lands exactly on the next delimiter. When the part was already
        // consumed, the delimiter sits at the buffer head and the first probe returns.
        for (;;)
        {
            if (await nextSpan(() => undefined))
            {
                break;
            }
        }
    }
}
