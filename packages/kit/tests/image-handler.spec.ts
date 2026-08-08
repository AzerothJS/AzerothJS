// @vitest-environment node
//
// The image endpoint: content-addressed transforms over an optional adapter. Without an
// adapter it is a caching passthrough with immutable headers; with one, the format is
// Accept-negotiated and every parameter rides the cache key. Local sources stay inside
// the root by the same two-step containment static file serving uses; remote sources
// need an exact-origin allowlist. A broken adapter degrades to original bytes, never a
// blank image.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { App } from '@azerothjs/http';
import { MemoryImageCache, imageHandler, mountPages, type ImageAdapter, type PageRoute } from '@azerothjs/kit';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeRoot(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-img-'));
    writeFileSync(join(dir, 'hero.png'), PNG);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    return dir;
}

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function serve(options: Partial<Parameters<typeof imageHandler>[0]> = {}): { app: App; root: string }
{
    const root = options.root ?? makeRoot();
    if (options.root === undefined)
    {
        dirs.push(root);
    }
    const app = new App();
    app.get('/_image', imageHandler({ root, ...options }));
    return { app, root };
}

const get = (app: App, query: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(new Request(`http://local/_image?${ query }`, { headers }));

describe('imageHandler without an adapter', () =>
{
    it('serves original bytes with immutable caching, an etag, and miss-then-hit verdicts', async () =>
    {
        const { app } = serve();
        const first = await get(app, 'src=%2Fhero.png');
        expect(first.status).toBe(200);
        expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG);
        expect(first.headers.get('content-type')).toBe('image/png');
        expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(first.headers.get('x-azeroth-image')).toBe('miss');
        const etag = first.headers.get('etag');
        expect(etag).not.toBeNull();

        const second = await get(app, 'src=%2Fhero.png');
        expect(second.headers.get('x-azeroth-image')).toBe('hit');

        const conditional = await get(app, 'src=%2Fhero.png', { 'if-none-match': etag as string });
        expect(conditional.status).toBe(304);
    });

    it('rejects traversal, dotfiles, null bytes, and bad params without touching the filesystem', async () =>
    {
        const { app } = serve();
        expect((await get(app, `src=${ encodeURIComponent('/../secret.png') }`)).status).toBe(404);
        expect((await get(app, `src=${ encodeURIComponent('/.env') }`)).status).toBe(404);
        expect((await get(app, `src=${ encodeURIComponent('/he\0ro.png') }`)).status).toBe(404);
        expect((await get(app, 'src=%2Fhero.png&w=0')).status).toBe(400);
        expect((await get(app, 'src=%2Fhero.png&w=nope')).status).toBe(400);
        expect((await get(app, 'src=%2Fhero.png&w=99999')).status).toBe(400);
        expect((await get(app, 'w=64')).status).toBe(400);
        expect((await get(app, 'src=hero.png')).status).toBe(400);
    });

    it('refuses remote sources by default and fetches allowlisted origins through the injected fetch', async () =>
    {
        const { app } = serve();
        expect((await get(app, `src=${ encodeURIComponent('https://cdn.example/pic.png') }`)).status).toBe(403);

        const fetchImpl = vi.fn(() => Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })));
        const { app: allowing } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl });
        const response = await get(allowing, `src=${ encodeURIComponent('https://cdn.example/pic.png') }`);
        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect((await get(allowing, `src=${ encodeURIComponent('https://evil.example/pic.png') }`)).status).toBe(403);
    });
});

describe('imageHandler with an adapter', () =>
{
    function fakeAdapter(): { adapter: ImageAdapter; calls: Array<{ width?: number; quality?: number; format?: string }> }
    {
        const calls: Array<{ width?: number; quality?: number; format?: string }> = [];
        return {
            calls,
            adapter: {
                transform: (input, options): Promise<{ data: Uint8Array; contentType: string }> =>
                {
                    calls.push({ ...options });
                    return Promise.resolve({ data: input.slice(0, 4), contentType: `image/${ options.format ?? 'png' }` });
                }
            }
        };
    }

    it('negotiates the format from Accept, snaps the width, and caches per key with vary: accept', async () =>
    {
        const { adapter, calls } = fakeAdapter();
        const { app } = serve({ adapter });
        const first = await get(app, 'src=%2Fhero.png&w=300&q=50', { accept: 'image/avif,image/webp,*/*' });
        expect(first.status).toBe(200);
        expect(first.headers.get('content-type')).toBe('image/avif');
        expect(first.headers.get('vary')).toBe('accept');
        expect(calls).toEqual([{ width: 384, quality: 50, format: 'avif' }]);

        await get(app, 'src=%2Fhero.png&w=300&q=50', { accept: 'image/avif,image/webp,*/*' });
        expect(calls.length).toBe(1);

        await get(app, 'src=%2Fhero.png&w=300&q=50', { accept: 'image/webp' });
        expect(calls.length).toBe(2);
        expect(calls[1]?.format).toBe('webp');
    });

    it('a throwing adapter serves the ORIGINAL bytes uncached with must-revalidate and reports onError', async () =>
    {
        const onError = vi.fn();
        const { app } = serve({
            adapter: { transform: () => Promise.reject(new Error('codec exploded')) },
            onError
        });
        const response = await get(app, 'src=%2Fhero.png&w=640', { accept: 'image/webp' });
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
        expect(response.headers.get('x-azeroth-image')).toBe('fallback');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('MemoryImageCache evicts by byte budget', async () =>
    {
        const cache = new MemoryImageCache({ maxBytes: 8 });
        await cache.set('a', { data: new Uint8Array(6), contentType: 'image/png' });
        await cache.set('b', { data: new Uint8Array(6), contentType: 'image/png' });
        expect(await cache.get('a')).toBeUndefined();
        expect((await cache.get('b'))?.data.length).toBe(6);
    });
});

describe('mountPages image wiring', () =>
{
    it('images: true serves /_image before the asset fallback; hashed assets go immutable', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-img-mount-'));
        dirs.push(dir);
        writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>');
        writeFileSync(join(dir, 'hero.png'), PNG);
        mkdirSync(join(dir, 'assets'));
        writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

        const component = (): HTMLElement => (undefined as unknown as HTMLElement);
        const routes: PageRoute[] = [{ path: '/', component, render: 'client' }];
        const app = new App();
        mountPages(app, { routes, clientDir: dir, images: true });

        const image = await app.handle(new Request('http://local/_image?src=%2Fhero.png'));
        expect(image.status).toBe(200);
        expect(image.headers.get('x-azeroth-image')).toBe('miss');

        const asset = await app.handle(new Request('http://local/assets/app.js'));
        expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

        const shell = await app.handle(new Request('http://local/'));
        expect(await shell.text()).toContain('<div id="root">');
    });
});
