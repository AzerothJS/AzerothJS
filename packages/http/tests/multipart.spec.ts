// @vitest-environment node
//
// The from-scratch multipart reader. The headline test parses what a REAL client produces
// (undici's FormData serialization - the same wire format browsers emit); the hand-crafted
// fixtures then pin binary safety and every framing violation as a typed error. Nothing here
// may hang or crash on hostile input - malformed framing is always a 400 with a stable code.

import { describe, it, expect } from 'vitest';
import { readMultipart, boundaryOf } from '../src/multipart.ts';
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
