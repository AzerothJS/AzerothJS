// @vitest-environment node
//
// The pull-based multipart iterator - the beyond-memory twin of readMultipart. The
// headline property is CHUNK-EDGE SAFETY: the same body must parse byte-identically no
// matter where the transport splits it, including splits INSIDE a boundary. The equivalence
// test then welds streaming mode to the buffered parser: one wire format, two readers,
// identical results.

import { describe, it, expect } from 'vitest';
import { readMultipart, streamMultipart, type MultipartPartStream } from '../src/multipart.ts';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from '../src/errors.ts';

/** A request whose multipart body is built by the platform itself - the honest fixture. */
function realFormRequest(build: (form: FormData) => void): Request
{
    const form = new FormData();
    build(form);
    return new Request('http://local/upload', { method: 'POST', body: form });
}

/** A raw multipart request delivered in chunks of `size` bytes - the adversarial transport. */
function chunkedRequest(body: string | Uint8Array, size: number, boundary = 'xyz'): Request
{
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
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
        headers: { 'content-type': `multipart/form-data; boundary=${ boundary }` },
        duplex: 'half'
    } as RequestInit);
}

/** Collects every part with buffered payloads, for equivalence assertions. */
async function collect(request: Request): Promise<Array<{ name: string; filename: string | null; contentType: string; data: Uint8Array }>>
{
    const parts: Array<{ name: string; filename: string | null; contentType: string; data: Uint8Array }> = [];
    for await (const part of streamMultipart(request))
    {
        parts.push({ name: part.name, filename: part.filename, contentType: part.contentType, data: await part.bytes() });
    }
    return parts;
}

const FIXTURE =
    '--xyz\r\ncontent-disposition: form-data; name="title"\r\n\r\nhello\r\n'
    + '--xyz\r\ncontent-disposition: form-data; name="file"; filename="a.bin"\r\ncontent-type: application/octet-stream\r\n\r\n'
    + 'binary\r\n--not-the-boundary\r\npayload'
    + '\r\n--xyz\r\ncontent-disposition: form-data; name="note"\r\n\r\nbye\r\n'
    + '--xyz--\r\nepilogue ignored';

describe('chunk-edge safety', () =>
{
    it('parses byte-identically at EVERY chunk size, including splits inside boundaries', async () =>
    {
        for (const size of [1, 2, 3, 5, 7, 16, 64, 4096])
        {
            const parts = await collect(chunkedRequest(FIXTURE, size));
            expect(parts.map((p) => p.name)).toEqual(['title', 'file', 'note']);
            expect(new TextDecoder().decode(parts[0]!.data)).toBe('hello');
            expect(new TextDecoder().decode(parts[1]!.data)).toBe('binary\r\n--not-the-boundary\r\npayload');
            expect(parts[1]!.filename).toBe('a.bin');
            expect(parts[1]!.contentType).toBe('application/octet-stream');
            expect(new TextDecoder().decode(parts[2]!.data)).toBe('bye');
        }
    });

    it('a large payload arrives INCREMENTALLY, not as one buffered block', async () =>
    {
        const payload = 'x'.repeat(4096);
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"; filename="f"\r\n\r\n${ payload }\r\n--xyz--`;
        for await (const part of streamMultipart(chunkedRequest(body, 128)))
        {
            let reads = 0;
            let total = 0;
            const reader = part.stream.getReader();
            for (;;)
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    break;
                }
                reads++;
                total += value.byteLength;
            }
            expect(total).toBe(4096);
            expect(reads).toBeGreaterThan(1); // streamed, not accumulated
        }
    });
});

describe('edge payloads', () =>
{
    it('an empty part and a part ending exactly at a chunk edge both round-trip', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="empty"; filename="zero.bin"\r\n\r\n'
            + '\r\n--xyz\r\ncontent-disposition: form-data; name="v"\r\n\r\nok\r\n--xyz--';
        for (const size of [1, 3, 8, 64])
        {
            const parts = await collect(chunkedRequest(body, size));
            expect(parts.map((p) => p.name)).toEqual(['empty', 'v']);
            expect(parts[0]!.data.byteLength).toBe(0);
            expect(new TextDecoder().decode(parts[1]!.data)).toBe('ok');
        }
    });

    it('breaking out of the loop early releases the body reader (no hang, no leak)', async () =>
    {
        const request = chunkedRequest(FIXTURE, 16);
        for await (const part of streamMultipart(request))
        {
            expect(part.name).toBe('title');
            break; // the generator's finally must cancel the reader
        }
        expect(request.bodyUsed).toBe(true);
    });
});

describe('equivalence with the buffered reader', () =>
{
    it('a real FormData body yields the same fields and byte-exact files both ways', async () =>
    {
        const bytes = new Uint8Array([0, 1, 2, 255, 254, 13, 10, 45, 45, 0]);
        const build = (form: FormData): void =>
        {
            form.append('title', 'Screenshot of the café');
            form.append('shot', new Blob([bytes], { type: 'image/png' }), 'shot.png');
        };

        const buffered = await readMultipart(realFormRequest(build));
        const streamed = await collect(realFormRequest(build));

        expect(streamed.map((p) => p.name)).toEqual(['title', 'shot']);
        expect(new TextDecoder().decode(streamed[0]!.data)).toBe(buffered.fields.get('title'));
        expect([...streamed[1]!.data]).toEqual([...buffered.files[0]!.data]);
        expect(streamed[1]!.contentType).toBe('image/png');
    });
});

describe('single-pass discipline', () =>
{
    it('advancing past an unread part discards it and lands on the next', async () =>
    {
        const seen: string[] = [];
        for await (const part of streamMultipart(chunkedRequest(FIXTURE, 7)))
        {
            seen.push(part.name); // never touches part.stream
        }
        expect(seen).toEqual(['title', 'file', 'note']);
    });

    it('a part consumed and a part skipped coexist', async () =>
    {
        const texts: Record<string, string> = {};
        for await (const part of streamMultipart(chunkedRequest(FIXTURE, 5)))
        {
            if (part.name !== 'file')
            {
                texts[part.name] = await part.text();
            }
        }
        expect(texts).toEqual({ title: 'hello', note: 'bye' });
    });
});

describe('limits and framing', () =>
{
    it('wrong content type is a 415 before any body read', async () =>
    {
        const request = new Request('http://local/upload', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        await expect((async () =>
        {
            for await (const part of streamMultipart(request))
            {
                void part;
            }
        })())
            .rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    });

    it('a missing closing boundary is a typed 400 surfaced on consumption', async () =>
    {
        const body = '--xyz\r\ncontent-disposition: form-data; name="f"\r\n\r\ntruncated';
        await expect(collect(chunkedRequest(body, 4))).rejects.toBeInstanceOf(BadRequestError);
    });

    it('a body with no boundary at all is a typed 400', async () =>
    {
        await expect(collect(chunkedRequest('no delimiters here', 4))).rejects.toBeInstanceOf(BadRequestError);
    });

    it('maxParts caps the iterator', async () =>
    {
        const request = chunkedRequest(FIXTURE, 16);
        const run = async (): Promise<void> =>
        {
            for await (const part of streamMultipart(request, { maxParts: 2 }))
            {
                void part;
            }
        };
        await expect(run()).rejects.toMatchObject({ code: 'too-many-parts' });
    });

    it('maxPartBytes fails the part stream mid-flight', async () =>
    {
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"; filename="f"\r\n\r\n${ 'x'.repeat(1000) }\r\n--xyz--`;
        const run = async (): Promise<void> =>
        {
            for await (const part of streamMultipart(chunkedRequest(body, 64), { maxPartBytes: 100 }))
            {
                await part.bytes();
            }
        };
        await expect(run()).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('bytes() enforces its own buffering cap independently', async () =>
    {
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"; filename="f"\r\n\r\n${ 'x'.repeat(1000) }\r\n--xyz--`;
        const run = async (): Promise<void> =>
        {
            for await (const part of streamMultipart(chunkedRequest(body, 64)))
            {
                await part.bytes(100);
            }
        };
        await expect(run()).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('an oversized part header block is a typed 400, never a hang', async () =>
    {
        const body = `--xyz\r\ncontent-disposition: form-data; name="f"\r\nx-padding: ${ 'p'.repeat(20 * 1024) }\r\n\r\nv\r\n--xyz--`;
        await expect(collect(chunkedRequest(body, 512))).rejects.toMatchObject({ code: 'malformed-multipart' });
    });
});

describe('the part surface', () =>
{
    it('exposes name, filename, contentType, and text() for field parts', async () =>
    {
        for await (const part of streamMultipart(chunkedRequest(FIXTURE, 32)))
        {
            const surface: MultipartPartStream = part;
            expect(typeof surface.name).toBe('string');
            if (part.name === 'title')
            {
                expect(part.filename).toBeNull();
                expect(part.contentType).toBe('application/octet-stream');
                expect(await part.text()).toBe('hello');
            }
        }
    });
});
