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
