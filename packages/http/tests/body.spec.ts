// @vitest-environment node
//
// Body readers: limits enforced WHILE streaming (a lying Content-Length cannot beat the cap),
// wrong content types rejected before parsing, malformed input mapped to typed kernel errors.

import { describe, it, expect } from 'vitest';
import { readRaw, readText, readJson, readForm, DEFAULT_BODY_LIMIT } from '../src/body.ts';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from '../src/errors.ts';

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request
{
    return new Request('http://local/x', { method: 'POST', body, headers });
}

function jsonPost(value: unknown): Request
{
    return post(JSON.stringify(value), { 'content-type': 'application/json' });
}

describe('readRaw: the limited streaming primitive', () =>
{
    it('reads a body into one buffer', async () =>
    {
        const raw = await readRaw(post('hello'));
        expect(new TextDecoder().decode(raw)).toBe('hello');
    });

    it('an absent body reads as empty', async () =>
    {
        const raw = await readRaw(new Request('http://local/x'));
        expect(raw.byteLength).toBe(0);
    });

    it('fails fast on a declared Content-Length above the limit, without reading', async () =>
    {
        const request = post('irrelevant', { 'content-length': String(DEFAULT_BODY_LIMIT + 1) });
        await expect(readRaw(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('enforces the cap while streaming even when no Content-Length is declared', async () =>
    {
        // A chunked producer that would emit 4 KiB against a 1 KiB limit; the reader must
        // abort after crossing the cap, not buffer the whole thing first.
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller)
            {
                pulls++;
                if (pulls > 8)
                {
                    controller.close();
                    return;
                }
                controller.enqueue(new Uint8Array(512));
            }
        });
        const request = new Request('http://local/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
        await expect(readRaw(request, { limit: 1024 })).rejects.toBeInstanceOf(PayloadTooLargeError);
        expect(pulls).toBeLessThan(8); // it stopped pulling once the cap was crossed
    });

    it('a body exactly at the limit passes', async () =>
    {
        const raw = await readRaw(post('x'.repeat(64)), { limit: 64 });
        expect(raw.byteLength).toBe(64);
    });
});

describe('readJson', () =>
{
    it('parses a typed JSON body', async () =>
    {
        const value = await readJson<{ n: number }>(jsonPost({ n: 42 }));
        expect(value.n).toBe(42);
    });

    it('accepts +json suffixed media types', async () =>
    {
        const request = post('{"ok":true}', { 'content-type': 'application/problem+json' });
        await expect(readJson(request)).resolves.toEqual({ ok: true });
    });

    it('rejects a missing or wrong content type as 415', async () =>
    {
        await expect(readJson(post('{"ok":true}', { 'content-type': 'text/plain' })))
            .rejects.toBeInstanceOf(UnsupportedMediaTypeError);
        await expect(readJson(post('{"ok":true}'))).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    });

    it('maps malformed JSON to a 400 with a stable code', async () =>
    {
        const failure = await readJson(post('{oops', { 'content-type': 'application/json' })).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(BadRequestError);
        expect((failure as BadRequestError).code).toBe('malformed-json');
    });

    it('maps an empty JSON body to a 400 (empty-body), not a parse crash', async () =>
    {
        const failure = await readJson(post(null, { 'content-type': 'application/json' })).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(BadRequestError);
        expect((failure as BadRequestError).code).toBe('empty-body');
    });
});

describe('readForm and readText', () =>
{
    it('parses urlencoded pairs, preserving repeats', async () =>
    {
        const request = post('a=1&b=two&a=3', { 'content-type': 'application/x-www-form-urlencoded' });
        const form = await readForm(request);
        expect(form.getAll('a')).toEqual(['1', '3']);
        expect(form.get('b')).toBe('two');
    });

    it('readForm rejects a non-form content type', async () =>
    {
        await expect(readForm(jsonPost({}))).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
    });

    it('readText decodes UTF-8', async () =>
    {
        expect(await readText(post('café'))).toBe('café');
    });
});
