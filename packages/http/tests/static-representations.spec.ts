// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { App } from '@azerothjs/http';
import { compressResponse, staticFiles } from '@azerothjs/http/node';

const source = 'export const parcel = "cargo";\n'.repeat(200);
const br = brotliCompressSync(source);
const gzip = gzipSync(source);
const stamp = new Date('2026-01-02T12:00:00Z');
let root: string;
let file: string;

beforeEach(async () =>
{
    root = await mkdtemp(join(tmpdir(), 'azeroth-static-codings-'));
    file = join(root, 'parcel.js');
    for (const [path, bytes] of [[file, source], [file + '.br', br], [file + '.gz', gzip]] as const)
    {
        await writeFile(path, bytes);
        await utimes(path, stamp, stamp);
    }
});
afterEach(async () => rm(root, { recursive: true, force: true }));

function mount(precompressed: boolean, cacheControl = 'public, max-age=300'): App
{
    const app = new App();
    app.get('/assets/*path', staticFiles(root, { precompressed, cacheControl }));
    return app;
}

async function ask(app: App, headers: Record<string, string>, method = 'GET', live = false): Promise<Response>
{
    const request = new Request('http://local/assets/parcel.js', { method, headers });
    const response = await app.handle(request);
    return live ? compressResponse(request, response) : response;
}

describe('negotiated static representations', () =>
{
    it.each([
        ['br, gzip', 'br', br], ['br;q=0.1,gzip;q=0.9', 'gzip', gzip],
        ['br;q=0, *', 'gzip', gzip], ['identity', null, Buffer.from(source)]
    ] as const)('serves the selected bytes and matching HEAD for %s', async (accept, coding, bytes) =>
    {
        const app = mount(true);
        const headers = { 'accept-encoding': accept };
        const get = await ask(app, headers);
        const head = await ask(app, headers, 'HEAD');
        expect(get.status).toBe(200);
        expect(get.headers.get('content-encoding')).toBe(coding);
        expect(get.headers.get('content-length')).toBe(String(bytes.length));
        expect(get.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(get.headers.get('accept-ranges')).toBe(coding === null ? 'bytes' : null);
        expect(get.headers.get('vary')).toBe('accept-encoding');
        expect([...head.headers]).toEqual([...get.headers]);
        expect(head.body).toBeNull();
        expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    });

    it('revalidates the selected stored representation by tag, list, weak tag, wildcard or date', async () =>
    {
        const app = mount(true);
        const headers = { 'accept-encoding': 'br' };
        const get = await ask(app, headers);
        const tag = get.headers.get('etag')!;
        const date = get.headers.get('last-modified')!;
        await get.arrayBuffer();
        const validators: Record<string, string>[] = [
            { 'if-none-match': tag }, { 'if-none-match': `"other", W/${ tag }` },
            { 'if-none-match': '*' }, { 'if-modified-since': date }
        ];
        for (const validator of validators)
        {
            const res = await ask(app, { ...headers, ...validator }, 'GET', true);
            expect(res.status).toBe(304);
            expect(res.body).toBeNull();
            expect(res.headers.get('etag')).toBe(tag);
            expect(res.headers.get('vary')).toBe('accept-encoding');
            expect(res.headers.get('cache-control')).toBe('public, max-age=300');
        }
        const gzipResult = await ask(app, { 'accept-encoding': 'br;q=0,gzip', 'if-none-match': tag, 'if-modified-since': date });
        expect(gzipResult.status).toBe(200);
        expect(gzipResult.headers.get('etag')).not.toBe(tag);
        expect(Buffer.from(await gzipResult.arrayBuffer())).toEqual(gzip);
    });

    it('invalidates a stored validator when a sibling is replaced with the same size and mtime', async () =>
    {
        const app = mount(true);
        const headers = { 'accept-encoding': 'gzip' };
        const first = await ask(app, headers);
        const tag = first.headers.get('etag')!;
        const date = first.headers.get('last-modified');
        expect(Buffer.from(await first.arrayBuffer())).toEqual(gzip);

        // Change just the gzip OS byte. Both equally long representations decode to the source.
        const replacement = Buffer.from(gzip);
        replacement.writeUInt8(replacement.readUInt8(9) ^ 0xff, 9);
        expect(gunzipSync(replacement).toString()).toBe(source);
        await writeFile(file + '.gz', replacement);
        await utimes(file + '.gz', stamp, stamp);

        const next = await ask(app, { ...headers, 'if-none-match': tag });
        expect(next.status).toBe(200);
        expect(next.headers.get('etag')).not.toBe(tag);
        expect(next.headers.get('last-modified')).toBe(date);
        expect(next.headers.get('content-length')).toBe(String(gzip.length));
        expect(Buffer.from(await next.arrayBuffer())).toEqual(replacement);
    });

    it('falls through stale and missing siblings and requires the original', async () =>
    {
        const app = mount(true);
        const headers = { 'accept-encoding': 'br, gzip' };
        await utimes(file + '.br', 0, 0);
        const fallback = await ask(app, headers);
        expect(fallback.headers.get('content-encoding')).toBe('gzip');
        expect(Buffer.from(await fallback.arrayBuffer())).toEqual(gzip);
        await rm(file + '.gz');
        const identity = await ask(app, headers);
        expect(identity.headers.get('content-encoding')).toBeNull();
        expect(await identity.text()).toBe(source);
        await rm(file);
        expect((await ask(app, headers)).status).toBe(404);
    });

    it('uses identity offsets even when the client asks for Brotli and the outer compressor is installed', async () =>
    {
        const app = mount(true);
        const request = { range: 'bytes=4-13', 'accept-encoding': 'br' };
        const partial = await ask(app, request, 'GET', true);
        expect(partial.status).toBe(206);
        expect(partial.headers.get('content-encoding')).toBeNull();
        expect(partial.headers.get('content-range')).toBe(`bytes 4-13/${ source.length }`);
        expect(await partial.text()).toBe(source.slice(4, 14));
        const full = await ask(app, { ...request, 'if-range': '"other"' }, 'GET', true);
        expect(full.status).toBe(200);
        expect(full.headers.get('content-encoding')).toBeNull();
        expect(await full.text()).toBe(source);
    });

    it('keeps live and stored tags distinct and revalidates only a variant the writer can send', async () =>
    {
        const app = mount(false);
        const headers = { 'accept-encoding': 'br' };
        const dynamic = await ask(app, headers, 'GET', true);
        const liveTag = dynamic.headers.get('etag')!;
        await dynamic.arrayBuffer();
        const repeat = { ...headers, 'if-none-match': liveTag };
        const bare = await ask(app, repeat);
        expect(bare.status).toBe(200);
        expect(await bare.text()).toBe(source);
        const live = await ask(app, repeat, 'GET', true);
        expect(live.status).toBe(304);
        expect(live.headers.get('etag')).toBe(liveTag);
        expect(live.headers.get('vary')).toBe('accept-encoding');
        const stored = await ask(mount(true), repeat, 'GET', true);
        expect(stored.status).toBe(200);
        expect(stored.headers.get('etag')).not.toBe(liveTag);
        expect(Buffer.from(await stored.arrayBuffer())).toEqual(br);
        const noTransform = await ask(mount(true, 'public, no-transform'), headers, 'GET', true);
        expect(noTransform.headers.get('content-encoding')).toBeNull();
        expect(await noTransform.text()).toBe(source);
    });
});
