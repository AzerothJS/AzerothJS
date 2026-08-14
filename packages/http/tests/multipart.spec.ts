// @vitest-environment node
//
// The from-scratch multipart reader. The headline test parses what a REAL client produces
// (undici's FormData serialization - the same wire format browsers emit); the hand-crafted
// fixtures then pin binary safety and every framing violation as a typed error. Nothing here
// may hang or crash on hostile input - malformed framing is always a 400 with a stable code.

import { describe, it, expect } from 'vitest';
import { readMultipart, streamMultipart, boundaryOf } from '../src/multipart.ts';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from '../src/errors.ts';

/** A request whose multipart body is built by the platform itself - the honest fixture. */
function realFormRequest(build: (form: FormData) => void): Request
{
    const form = new FormData();
    build(form);
    return new Request('http://local/upload', { method: 'POST', body: form });
}

/** A hand-crafted raw multipart request for exact framing control. */
function rawRequest(body: string | Uint8Array, boundary = 'xyz'): Request
{
    return new Request('http://local/upload', {
        method: 'POST',
        body: typeof body === 'string' ? body : new Uint8Array(body), // ArrayBuffer-backed copy for BodyInit
        headers: { 'content-type': `multipart/form-data; boundary=${ boundary }` }
    });
}

/** A raw multipart request delivered in chunks of `size` bytes - the adversarial transport. */
function chunkedRequest(body: string, size: number): Request
{
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller): void
        {
            if (offset >= bytes.byteLength)
            {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        }
    });
    return new Request('http://local/upload', {
        method: 'POST',
        body: stream,
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
        duplex: 'half'
    } as RequestInit);
}

describe('parsing a real client body (undici FormData serialization)', () =>
{
    it('reads text fields and a binary file exactly as posted', async () =>
    {
        const bytes = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 45, 45, 0]); // CRLF and dashes inside
        const request = realFormRequest((form) =>
        {
            form.append('title', 'Screenshot of the café');
            form.append('tags', 'a');
            form.append('tags', 'b');
            form.append('shot', new Blob([bytes], { type: 'image/png' }), 'shot.png');
        });

        const parsed = await readMultipart(request);
        expect(parsed.fields.get('title')).toBe('Screenshot of the café');
        expect(parsed.fields.getAll('tags')).toEqual(['a', 'b']);
        expect(parsed.files).toHaveLength(1);
        expect(parsed.files[0]!.name).toBe('shot');
        expect(parsed.files[0]!.filename).toBe('shot.png');
        expect(parsed.files[0]!.contentType).toBe('image/png');
        expect([...parsed.files[0]!.data]).toEqual([...bytes]);
    });

    it('an empty file part round-trips as zero bytes', async () =>
    {
        const request = realFormRequest((form) => form.append('empty', new Blob([]), 'zero.bin'));
        const parsed = await readMultipart(request);
        expect(parsed.files[0]!.data.byteLength).toBe(0);
    });
});

describe('boundary extraction', () =>
{
    it('reads unquoted and quoted boundaries', () =>
    {
        expect(boundaryOf('multipart/form-data; boundary=abc123')).toBe('abc123');
        expect(boundaryOf('multipart/form-data; boundary="with spaces ok"')).toBe('with spaces ok');
    });

    it('rejects other media types, missing and oversized boundaries', () =>
    {
        expect(boundaryOf('application/json')).toBeNull();
        expect(boundaryOf('multipart/form-data')).toBeNull();
        expect(boundaryOf(`multipart/form-data; boundary=${ 'x'.repeat(71) }`)).toBeNull();
    });

    it('readMultipart maps a wrong content type to 415', async () =>
    {
        const request = new Request('http://local/upload', {
            method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }
        });
        await expect(readMultipart(request)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    });
});

describe('framing violations are typed 400s, never hangs', () =>
{
    async function failure(body: string): Promise<BadRequestError>
    {
        return await readMultipart(rawRequest(body)).catch((e: unknown) => e) as BadRequestError;
    }

    it('a body with no boundary at all', async () =>
    {
        const error = await failure('no delimiters anywhere');
        expect(error).toBeInstanceOf(BadRequestError);
        expect(error.code).toBe('malformed-multipart');
    });

    it('a missing terminal boundary', async () =>
    {
        const error = await failure('--xyz\r\ncontent-disposition: form-data; name="a"\r\n\r\nvalue\r\n');
        expect(error.code).toBe('malformed-multipart');
    });

    it('a part without a field name', async () =>
    {
        const error = await failure('--xyz\r\ncontent-type: text/plain\r\n\r\nvalue\r\n--xyz--');
        expect(error.code).toBe('malformed-multipart');
    });

    it('a part that is not form-data', async () =>
    {
        const error = await failure('--xyz\r\ncontent-disposition: attachment; name="a"\r\n\r\nv\r\n--xyz--');
        expect(error.code).toBe('malformed-multipart');
    });

    it('a payload not CRLF-delimited from its boundary', async () =>
    {
        const error = await failure('--xyz\r\ncontent-disposition: form-data; name="a"\r\n\r\nvalue--xyz--');
        expect(error.code).toBe('malformed-multipart');
    });
});

describe('preamble, epilogue, and quoted params', () =>
{
    it('ignores preamble before the first boundary and epilogue after the last', async () =>
    {
        const body = 'this is preamble\r\n--xyz\r\ncontent-disposition: form-data; name="a"\r\n\r\n1\r\n--xyz--\r\nepilogue';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.fields.get('a')).toBe('1');
    });

    it('reads quoted filenames containing spaces and semicolon-ish content', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="f"; filename="my file; v2.txt"\r\n\r\nhello\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.files[0]!.filename).toBe('my file; v2.txt');
    });

    it('reads the LAST parameter, which no separator terminates', async () =>
    {
        // The final run ends at the string's end, not at a `;`. It is flushed after the
        // scan; spelling that as one extra loop iteration meant indexing one past the end.
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; filename="last.txt"\r\n\r\nv\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.files[0]!.filename).toBe('last.txt');
        expect(parsed.files[0]!.name).toBe('a');
    });

    it('tolerates a trailing semicolon and repeated separators', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a";;\r\n\r\n1\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.fields.get('a')).toBe('1');
    });

    it('a semicolon inside the quoted NAME cannot smuggle a filename', async () =>
    {
        // The security property the quote-aware scan exists for: read naively, this part
        // would classify as a FILE named evil.exe. It is one field whose name contains
        // a semicolon, and no file part exists.
        const body = '--xyz\r\ncontent-disposition: form-data; name="note; filename=evil.exe"\r\n\r\n1\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.files).toHaveLength(0);
        expect(parsed.fields.get('note; filename=evil.exe')).toBe('1');
    });
});

describe('what counts as a FILE part', () =>
{
    /** A raw part whose payload is arbitrary bytes: text framing, binary body, byte-exact. */
    function binaryPart(disposition: string, payload: Uint8Array): Request
    {
        const head = new TextEncoder().encode(`--xyz\r\ncontent-disposition: ${ disposition }\r\n\r\n`);
        const tail = new TextEncoder().encode('\r\n--xyz--');
        const body = new Uint8Array(head.byteLength + payload.byteLength + tail.byteLength);
        body.set(head, 0);
        body.set(payload, head.byteLength);
        body.set(tail, head.byteLength + payload.byteLength);
        return rawRequest(body);
    }

    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);

    it('an RFC 8187 filename* part is a file: byte-exact and under maxFileSize', async () =>
    {
        // Classified as a text field it would face neither the per-file cap nor byte
        // preservation - the payload would come back UTF-8 mangled (0x89 -> 0xefbfbd).
        const request = binaryPart('form-data; name="shot"; filename*=UTF-8\'\'na%C3%AFve.png', PNG);
        const parsed = await readMultipart(request);
        expect(parsed.fields.getAll('shot')).toEqual([]);
        expect(parsed.files).toHaveLength(1);
        expect(parsed.files[0]!.filename).toBe('naïve.png');
        expect([...parsed.files[0]!.data]).toEqual([...PNG]);

        await expect(readMultipart(
            binaryPart('form-data; name="shot"; filename*=UTF-8\'\'big.bin', new Uint8Array(2048)),
            { maxFileSize: 1024 })).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('filename* wins over filename, and an undecodable one is still a file', async () =>
    {
        const both = await readMultipart(binaryPart(
            'form-data; name="f"; filename="legacy.bin"; filename*=UTF-8\'\'real.bin', PNG));
        expect(both.files[0]!.filename).toBe('real.bin');

        const broken = await readMultipart(binaryPart('form-data; name="f"; filename*=%%%', PNG));
        expect(broken.files).toHaveLength(1);
        expect([...broken.files[0]!.data]).toEqual([...PNG]);
    });

    it('a semicolon inside the quoted NAME cannot forge a filename', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="note; filename=evil.exe"\r\n\r\nhi\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.files).toEqual([]);
        expect(parsed.fields.get('note; filename=evil.exe')).toBe('hi');
    });
});

describe('limits', () =>
{
    it('caps the part count', async () =>
    {
        const parts = Array.from({ length: 5 }, (_, i) =>
            `--xyz\r\ncontent-disposition: form-data; name="f${ i }"\r\n\r\nv\r\n`).join('');
        const request = rawRequest(`${ parts }--xyz--`);
        const error = await readMultipart(request, { maxParts: 3 }).catch((e: unknown) => e) as BadRequestError;
        expect(error.code).toBe('too-many-parts');
    });

    it('caps a single file', async () =>
    {
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"; filename="big.bin"\r\n\r\n${ 'x'.repeat(100) }\r\n--xyz--`;
        await expect(readMultipart(rawRequest(body), { maxFileSize: 64 }))
            .rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('caps the total body through the streaming reader', async () =>
    {
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"\r\n\r\n${ 'x'.repeat(200) }\r\n--xyz--`;
        await expect(readMultipart(rawRequest(body), { limit: 64 }))
            .rejects.toBeInstanceOf(PayloadTooLargeError);
    });
});

describe('bare CR or LF inside part headers', () =>
{
    it('a bare LF inside a quoted filename is a typed 400, not a parsed part', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; filename="x\nsmuggled: header"\r\n\r\nv\r\n--xyz--';
        const error = await readMultipart(rawRequest(body)).catch((e: unknown) => e) as BadRequestError;
        expect(error).toBeInstanceOf(BadRequestError);
        expect(error.code).toBe('malformed-multipart');
    });

    it('a bare CR inside a header line is a typed 400', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"\rx-extra: y\r\n\r\nv\r\n--xyz--';
        const error = await readMultipart(rawRequest(body)).catch((e: unknown) => e) as BadRequestError;
        expect(error).toBeInstanceOf(BadRequestError);
        expect(error.code).toBe('malformed-multipart');
    });

    it('a percent-encoded CRLF in filename* is refused where the DECODED value is final', async () =>
    {
        // The header line carries `%0D%0A`, which no line-level check can see. Accepted, the
        // decoded filename would carry a CRLF into whatever sink echoes it.
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; '
            + 'filename*=UTF-8\'\'x%0D%0Ax-smuggled:%20yes\r\n\r\nv\r\n--xyz--';
        const error = await readMultipart(rawRequest(body)).catch((e: unknown) => e) as BadRequestError;
        expect(error).toBeInstanceOf(BadRequestError);
        expect(error.code).toBe('malformed-multipart');
    });

    it('the ISO-8859-1 extended form decodes through the same rule', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; '
            + 'filename*=ISO-8859-1\'\'x%0Ay\r\n\r\nv\r\n--xyz--';
        const error = await readMultipart(rawRequest(body)).catch((e: unknown) => e) as BadRequestError;
        expect(error).toBeInstanceOf(BadRequestError);
        expect(error.code).toBe('malformed-multipart');
    });

    it('the streaming twin refuses the same decoded value', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; '
            + 'filename*=UTF-8\'\'x%0D%0Ax-smuggled:%20yes\r\n\r\nv\r\n--xyz--';
        const run = async (): Promise<void> =>
        {
            for await (const part of streamMultipart(chunkedRequest(body, 16)))
            {
                void part;
            }
        };
        await expect(run()).rejects.toMatchObject({ code: 'malformed-multipart' });
    });

    it('a percent-encoded filename WITHOUT a line break still decodes and parses', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="a"; '
            + 'filename*=UTF-8\'\'caf%C3%A9%20menu.txt\r\n\r\nv\r\n--xyz--';
        const parsed = await readMultipart(rawRequest(body));
        expect(parsed.files[0]!.filename).toBe('café menu.txt');
    });
});

describe('maxPartBytes governs parts the consumer never reads', () =>
{
    const oversized = `--xyz\r\ncontent-disposition: form-data; name="f"; filename="f.bin"\r\n\r\n${ 'x'.repeat(1024 * 1024) }\r\n--xyz--`;

    async function skipAll(request: Request): Promise<void>
    {
        for await (const part of streamMultipart(request, { maxPartBytes: 4096 }))
        {
            void part; // never touches part.stream
        }
    }

    it('an oversized skipped part is a 413 when the body arrives in one chunk', async () =>
    {
        await expect(skipAll(chunkedRequest(oversized, oversized.length)))
            .rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('the same body in small chunks is the SAME 413, not a framing error', async () =>
    {
        await expect(skipAll(chunkedRequest(oversized, 16 * 1024)))
            .rejects.toBeInstanceOf(PayloadTooLargeError);
    });
});

describe('a yielded part pulls under backpressure only', () =>
{
    it('takes nothing off the socket between the yield and the consumer\'s first read', async () =>
    {
        // A part stream that pulls on construction reads payload the consumer has not asked
        // for - and scans the shared feed beside the generator's own discard loop.
        const head = '--xyz\r\ncontent-disposition: form-data; name="f"; filename="f.bin"\r\n\r\n';
        const payload = 'A'.repeat(4096);
        const pieces = [head, ...(`${ payload }\r\n--xyz--`.match(/[\s\S]{1,64}/g) ?? [])]
            .map((piece) => new TextEncoder().encode(piece));
        let delivered = 0;
        const source = new ReadableStream<Uint8Array>({
            pull(controller): void
            {
                const next = pieces[delivered];
                if (next === undefined)
                {
                    controller.close();
                    return;
                }
                delivered++;
                controller.enqueue(next);
            }
        }, { highWaterMark: 0 }); // the transport hands over a chunk only when asked
        const request = new Request('http://local/upload', {
            method: 'POST',
            body: source,
            headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
            duplex: 'half'
        } as RequestInit);

        let atYield = -1;
        let text = '';
        for await (const part of streamMultipart(request))
        {
            await new Promise((resolve) => setTimeout(resolve, 5)); // any read-ahead lands here
            atYield = delivered;
            text = await part.text();
            break;
        }
        expect(atYield).toBe(1); // the header chunk, and no byte of the payload
        expect(text).toBe(payload);
    });
});

describe('the streaming preamble is capped', () =>
{
    /** Drives the iterator to exhaustion, touching nothing. */
    async function drain(request: Request): Promise<void>
    {
        for await (const part of streamMultipart(request))
        {
            void part;
        }
    }

    it('an oversized preamble arriving in ONE chunk with the delimiter is a typed 400', async () =>
    {
        const body = `${ 'a'.repeat(64 * 1024) }\r\n--xyz\r\ncontent-disposition: form-data; name="f"\r\n\r\nv\r\n--xyz--`;
        await expect(drain(chunkedRequest(body, body.length))).rejects.toMatchObject({ code: 'malformed-multipart' });
    });

    it('the same preamble split across chunks is the SAME 400', async () =>
    {
        const body = `${ 'a'.repeat(64 * 1024) }\r\n--xyz\r\ncontent-disposition: form-data; name="f"\r\n\r\nv\r\n--xyz--`;
        await expect(drain(chunkedRequest(body, 4096))).rejects.toMatchObject({ code: 'malformed-multipart' });
    });

    it('a preamble under the cap is discarded, not refused', async () =>
    {
        const body = `${ 'a'.repeat(1024) }\r\n--xyz\r\ncontent-disposition: form-data; name="f"\r\n\r\nv\r\n--xyz--`;
        await expect(drain(chunkedRequest(body, body.length))).resolves.toBeUndefined();
    });

    it('a never-matching preamble flood stops at a bounded byte count with a typed 400', async () =>
    {
        const chunk = new Uint8Array(8 * 1024).fill(97);
        let delivered = 0;
        const source = new ReadableStream<Uint8Array>({
            pull(controller): void
            {
                if (delivered >= 8 * 1024 * 1024)
                {
                    controller.close();
                    return;
                }
                delivered += chunk.byteLength;
                controller.enqueue(chunk.slice());
            }
        });
        const request = new Request('http://local/upload', {
            method: 'POST',
            body: source,
            headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
            duplex: 'half'
        } as RequestInit);
        const run = async (): Promise<void> =>
        {
            for await (const part of streamMultipart(request))
            {
                void part;
            }
        };
        await expect(run()).rejects.toMatchObject({ code: 'malformed-multipart' });
        expect(delivered).toBeLessThan(1024 * 1024); // the flood is refused, not drained
    });
});

describe('the boundary scan cannot be made quadratic', () =>
{
    const PAYLOAD_BYTES = 2 * 1024 * 1024;

    /** How long readMultipart takes on a dash payload framed by `boundary` (best of 3 runs). */
    async function fastest(boundary: string): Promise<number>
    {
        const body = `--${ boundary }\r\ncontent-disposition: form-data; name="f"\r\n\r\n`
            + '-'.repeat(PAYLOAD_BYTES) + `\r\n--${ boundary }--`;
        let best = Infinity;
        for (let run = 0; run < 3; run++)
        {
            const started = performance.now();
            const parsed = await readMultipart(rawRequest(body, boundary));
            best = Math.min(best, performance.now() - started);
            expect(parsed.fields.get('f')!.length).toBe(PAYLOAD_BYTES);
        }
        return best;
    }

    it('a hostile boundary costs what a benign one costs', async () =>
    {
        // The client picks the boundary AND the payload. An un-prefixed `--`-leading delimiter
        // against a body of dashes compares the whole 70-byte boundary at EVERY offset, before
        // maxParts has any say: 40 ms of blocked event loop per MiB, against 2 ms benign.
        const benign = await fastest('xyz');
        const hostile = await fastest(`${ '-'.repeat(67) }X`);
        expect(hostile).toBeLessThan(benign * 3 + 15);
    }, 30_000);
});
