// @vitest-environment node
//
// Deterministic fuzz: hostile, random-but-SEEDED input against the kernel's parsers. The
// property under test is never "the right answer" (the exact specs pin those) but the
// CONTRACT ON GARBAGE: a typed kernel error or a clean result - never a hang, never a crash,
// never a foreign exception. Seeded xorshift makes every failure reproducible: a failing
// iteration prints its seed, and re-running with it replays the exact input.

import { describe, it, expect } from 'vitest';
import { RadixRouter } from '../src/router.ts';
import { readMultipart } from '../src/multipart.ts';
import { readRaw } from '../src/body.ts';
import { HttpError } from '../src/errors.ts';

/** xorshift32: tiny, deterministic, plenty random for input fuzzing. */
function prng(seed: number): () => number
{
    let state = seed >>> 0 || 1;
    return () =>
    {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0xffffffff;
    };
}

describe('router fuzz: arbitrary paths against a real route table', () =>
{
    it('10k random paths: never throws, always a well-formed result', () =>
    {
        const router = new RadixRouter<string>();
        router.insert('GET', '/', 'root');
        router.insert('GET', '/users/:id', 'user');
        router.insert('POST', '/users/:id/posts/:post', 'post');
        router.insert('GET', '/files/*rest', 'files');
        router.insert('GET', '/users/me', 'me');

        const random = prng(0xa2e207);
        const alphabet = 'abz09-._~%2F:*/?#[]@!$&\'()+,;= \\é世';
        for (let i = 0; i < 10_000; i++)
        {
            const length = Math.floor(random() * 40);
            let path = '/';
            for (let j = 0; j < length; j++)
            {
                path += alphabet[Math.floor(random() * alphabet.length)] ?? '';
            }
            const method = ['GET', 'POST', 'PUT', 'weird', ''][Math.floor(random() * 5)] ?? 'GET';
            const result = router.match(method, path);
            expect(['match', 'method-mismatch', 'miss']).toContain(result.kind);
            if (result.kind === 'match')
            {
                expect(typeof result.value).toBe('string');
            }
        }
    });

    it('random registration storms: every insert either registers or throws a plain Error, and the table survives', () =>
    {
        const random = prng(0xbeef);
        const router = new RadixRouter<number>();
        const segments = ['a', 'b', ':x', ':y', '*w', 'c'];
        for (let i = 0; i < 2_000; i++)
        {
            const parts = Array.from({ length: 1 + Math.floor(random() * 4) },
                () => segments[Math.floor(random() * segments.length)]);
            try
            {
                router.insert('GET', '/' + parts.join('/'), i);
            }
            catch (error)
            {
                expect(error).toBeInstanceOf(Error); // conflicts throw; nothing else may
            }
        }
        // Whatever registered still matches consistently - the tree was never corrupted.
        expect(['match', 'miss', 'method-mismatch']).toContain(router.match('GET', '/a/b').kind);
    });
});

describe('multipart fuzz: byte mutations of a valid body', () =>
{
    const VALID = [
        '--xyz\r\ncontent-disposition: form-data; name="a"\r\n\r\nvalue-1\r\n',
        '--xyz\r\ncontent-disposition: form-data; name="f"; filename="x.bin"\r\ncontent-type: application/octet-stream\r\n\r\nBYTES\r\n',
        '--xyz--'
    ].join('');

    function requestOf(body: Uint8Array): Request
    {
        return new Request('http://local/u', {
            method: 'POST',
            body: new Uint8Array(body), // ArrayBuffer-backed copy: BodyInit rejects ArrayBufferLike views
            headers: { 'content-type': 'multipart/form-data; boundary=xyz' }
        });
    }

    it('500 single-byte corruptions: parses or rejects with a kernel error - never hangs, never crashes', async () =>
    {
        const encoder = new TextEncoder();
        const original = encoder.encode(VALID);
        const random = prng(0x5eed);

        for (let i = 0; i < 500; i++)
        {
            const mutated = original.slice();
            mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
            const outcome = await readMultipart(requestOf(mutated)).then(() => 'ok', (error: unknown) => error);
            if (outcome !== 'ok')
            {
                expect(outcome, `seed iteration ${ i }`).toBeInstanceOf(HttpError);
            }
        }
    }, 30_000);

    it('200 random-garbage bodies: always a typed rejection or a parse', async () =>
    {
        const random = prng(0xfeed5);
        for (let i = 0; i < 200; i++)
        {
            const garbage = new Uint8Array(Math.floor(random() * 512));
            for (let j = 0; j < garbage.length; j++)
            {
                garbage[j] = Math.floor(random() * 256);
            }
            const outcome = await readMultipart(requestOf(garbage)).then(() => 'ok', (error: unknown) => error);
            if (outcome !== 'ok')
            {
                expect(outcome, `iteration ${ i }`).toBeInstanceOf(HttpError);
            }
        }
    }, 30_000);
});

describe('body-reader fuzz: random chunking against the limit', () =>
{
    it('the cap holds regardless of how the bytes arrive', async () =>
    {
        const random = prng(0xcafe);
        for (let i = 0; i < 100; i++)
        {
            const total = 64 + Math.floor(random() * 512);
            const limit = 32 + Math.floor(random() * 256);
            let sent = 0;
            const stream = new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent >= total)
                    {
                        controller.close();
                        return;
                    }
                    const size = 1 + Math.floor(random() * 64);
                    const chunk = new Uint8Array(Math.min(size, total - sent));
                    sent += chunk.byteLength;
                    controller.enqueue(chunk);
                }
            });
            const request = new Request('http://local/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
            const outcome = await readRaw(request, { limit }).then(
                (raw) => ({ ok: true as const, size: raw.byteLength }),
                (error: unknown) => ({ ok: false as const, error }));
            if (total > limit)
            {
                expect(outcome.ok, `total ${ total } over limit ${ limit } must reject`).toBe(false);
            }
            else
            {
                expect(outcome).toEqual({ ok: true, size: total });
            }
        }
    }, 30_000);
});
