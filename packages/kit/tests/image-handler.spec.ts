// @vitest-environment node
//
// The image endpoint: content-addressed transforms over an optional adapter. Without an
// adapter it is a caching passthrough with immutable headers; with one, the format is
// Accept-negotiated and every parameter rides the cache key. Local sources stay inside
// the root by the same two-step containment static file serving uses; remote sources
// need an exact-origin allowlist. A broken adapter degrades to original bytes, never a
// blank image.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
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

    it('does not follow redirects off an allowlisted origin', async () =>
    {
        // The allowlist is checked on the REQUESTED url only. Following redirects would let an
        // allowlisted origin - or an open redirect on one - bounce the fetch anywhere the server
        // can reach (cloud metadata, localhost admin ports), with the allowlist having approved
        // the first hop only.
        let seen: Request | null = null;
        const fetchImpl = vi.fn((request: Request) =>
        {
            seen = request;
            return Promise.resolve(new Response(null, {
                status: 302,
                headers: { location: 'http://169.254.169.254/latest/meta-data/' }
            }));
        });
        const { app } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl });

        const response = await get(app, `src=${ encodeURIComponent('https://cdn.example/pic.png') }`);

        expect(response.status).toBe(403);
        // The policy itself, not just this response: under 'follow' the hop would be invisible
        // here, because the fake transport cannot redirect on its own.
        expect((seen as unknown as Request).redirect).toBe('manual');
    });

    it('stops reading a remote body at the size cap instead of buffering it whole', async () =>
    {
        // The cap used to be checked AFTER arrayBuffer(), so it reported the violation only once
        // the memory had already been spent - a hostile allowlisted origin could hand back
        // gigabytes and take the process with it.
        const cap = 1024 * 1024;
        let pulled = 0;
        const body = (): ReadableStream<Uint8Array> =>
        {
            let sent = 0;
            const total = 40 * 1024 * 1024;
            return new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent >= total)
                    {
                        controller.close();
                        return;
                    }
                    const size = Math.min(256 * 1024, total - sent);
                    sent += size;
                    pulled += size;
                    controller.enqueue(new Uint8Array(size));
                }
            });
        };
        const { app } = serve({
            allowedOrigins: ['https://cdn.example'],
            maxSourceBytes: cap,
            fetchImpl: () => Promise.resolve(new Response(body(), { headers: { 'content-type': 'image/png' } }))
        });

        const response = await get(app, `src=${ encodeURIComponent('https://cdn.example/big.png') }`);

        expect(response.status).toBe(400);
        // Bounded by the cap plus at most a chunk of read-ahead. It was the full 40MB before.
        expect(pulled).toBeLessThan(cap * 3);
    });

    it('refuses a declared content-length over the cap without reading the body', async () =>
    {
        let pulled = 0;
        const { app } = serve({
            allowedOrigins: ['https://cdn.example'],
            maxSourceBytes: 1024,
            fetchImpl: () => Promise.resolve(new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller)
                    {
                        pulled += 1;
                        controller.enqueue(new Uint8Array(16));
                    }
                }),
                { headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) } }
            ))
        });

        expect((await get(app, `src=${ encodeURIComponent('https://cdn.example/huge.png') }`)).status).toBe(400);
        // Not 0: a ReadableStream pre-pulls one chunk at construction, before the handler sees
        // the response at all. What matters is that the handler never started draining it.
        expect(pulled).toBeLessThanOrEqual(1);
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

describe('the source size limit is enforced against the file that is actually read', () =>
{
    // CodeQL js/file-system-race: the limit used to be checked with a standalone `stat` and the
    // bytes fetched by a separate `readFile`, so the size that was approved and the file that was
    // served did not have to be the same one. Both now go through a single open handle.

    it('refuses over the limit, serves exactly AT it, and keeps serving after a refusal', async () =>
    {
        const root = makeRoot();
        dirs.push(root);
        const limit = 1024;
        // Exactly at the limit and one byte past it: an off-by-one is where a size guard breaks,
        // and `>` vs `>=` is invisible to a test that only tries 4 KB against 1 KB.
        writeFileSync(join(root, 'exact.png'), new Uint8Array(limit));
        writeFileSync(join(root, 'over.png'), new Uint8Array(limit + 1));
        const { app } = serve({ root, maxSourceBytes: limit });

        const refused = await get(app, 'src=%2Fover.png');
        expect(refused.status).toBe(400);
        expect((await refused.json() as { error: { code: string } }).error.code).toBe('image-too-large');

        const atLimit = await get(app, 'src=%2Fexact.png');
        expect(atLimit.status).toBe(200);
        expect((await atLimit.arrayBuffer()).byteLength).toBe(limit);

        // The handler is still healthy after a refusal, so the refusal path released whatever it
        // opened. This is weaker than a descriptor-count assertion and is not offered as one.
        const served = await get(app, 'src=%2Fhero.png');
        expect(served.status).toBe(200);
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    });

    // NOT TESTED HERE: that the refusal path closes its handle. A descriptor-exhaustion test is
    // not portable (the limit is high and platform-specific), and the version of this test that
    // flooded the endpoint with refusals passed just as happily with `handle.close()` deleted -
    // so it asserted nothing. Verified by planting instead: removing the close makes Node raise
    // "A FileHandle object was closed during garbage collection ... is now considered an error"
    // on stderr. That is the real backstop; it does not fail vitest, so the `finally` is held in
    // place by review rather than by this file.
});

describe('a failing upstream is reported as an upstream failure', () =>
{
    // Every transport-level rejection - DNS failure, refused connection, TLS error, timeout - was
    // an uncaught TypeError, so a CDN outage answered "Internal server error" and pointed the
    // operator at THIS server. A gateway status names the side that actually failed.
    it('answers 502 when the remote cannot be fetched', async () =>
    {
        const fetchImpl = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
        const { app } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl });

        const response = await get(app, `src=${ encodeURIComponent('https://cdn.example/pic.png') }`);
        expect(response.status).toBe(502);
        expect((await response.json() as { error: { code: string } }).error.code).toBe('image-upstream');
    });

    it('answers 504 when the remote times out', async () =>
    {
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        const fetchImpl = vi.fn(() => Promise.reject(timeout));
        const { app } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl });

        expect((await get(app, `src=${ encodeURIComponent('https://cdn.example/pic.png') }`)).status).toBe(504);
    });

    it('answers 400 for a malformed remote src, not 500', async () =>
    {
        // The shape gate is a prefix test, so `https://[` passed it and `new URL` threw a
        // TypeError that surfaced as a 500 - the caller's mistake reported as the server's.
        const { app } = serve({ allowedOrigins: ['https://cdn.example'] });

        for (const bad of ['https://', 'https://['])
        {
            const response = await get(app, `src=${ encodeURIComponent(bad) }`);
            expect(response.status).toBe(400);
        }
    });
});

describe('only image bytes leave the endpoint', () =>
{
    // The allowlist establishes WHERE remote bytes come from, not that they are images. An
    // allowlisted bucket that also hosts user uploads can answer text/html, and relaying it
    // under this origin with a year of cache would be stored XSS.

    it('answers 415 when an allowlisted upstream declares a non-image content type', async () =>
    {
        const fetchImpl = vi.fn(() => Promise.resolve(new Response(
            '<script>alert(1)</script>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        )));
        const { app } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl });

        const response = await get(app, `src=${ encodeURIComponent('https://cdn.example/upload.png') }`);

        expect(response.status).toBe(415);
        expect((await response.json() as { error: { code: string } }).error.code).toBe('image-content-type');
    });

    it('answers 415 when the upstream declares no content type at all', async () =>
    {
        const body = new Response(new Uint8Array([1, 2, 3]));
        body.headers.delete('content-type');
        const { app } = serve({ allowedOrigins: ['https://cdn.example'], fetchImpl: () => Promise.resolve(body) });

        expect((await get(app, `src=${ encodeURIComponent('https://cdn.example/blob') }`)).status).toBe(415);
    });

    it('a throwing adapter cannot fall back to non-image upstream bytes', async () =>
    {
        // The fallback arm serves ORIGINAL bytes - exactly the arm a non-image reaches, since a
        // non-image is what makes a codec throw. The refusal happens at the read, so neither the
        // store arm nor the fallback arm ever holds the bytes.
        const onError = vi.fn();
        const fetchImpl = vi.fn(() => Promise.resolve(new Response(
            'not an image',
            { headers: { 'content-type': 'text/html' } }
        )));
        const { app } = serve({
            allowedOrigins: ['https://cdn.example'],
            fetchImpl,
            adapter: { transform: () => Promise.reject(new Error('codec exploded')) },
            onError
        });

        const response = await get(app, `src=${ encodeURIComponent('https://cdn.example/upload.png') }`, { accept: 'image/webp' });

        expect(response.status).toBe(415);
        expect(onError).not.toHaveBeenCalled();
    });

    it('image responses carry nosniff and render inline', async () =>
    {
        const { app } = serve();
        const response = await get(app, 'src=%2Fhero.png');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-disposition')).toBe('inline');
    });

    it('svg answers carry a sandboxing content security policy; rasters stay bare', async () =>
    {
        // SVG runs script when navigated to directly; the sandbox keeps it an image without
        // touching <img> embedding, which never scripts anyway.
        const root = makeRoot();
        dirs.push(root);
        writeFileSync(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const { app } = serve({ root });

        const svg = await get(app, `src=${ encodeURIComponent('/logo.svg') }`);
        expect(svg.status).toBe(200);
        expect(svg.headers.get('content-type')).toBe('image/svg+xml');
        expect(svg.headers.get('content-security-policy')).toContain('sandbox');

        const png = await get(app, 'src=%2Fhero.png');
        expect(png.headers.get('content-security-policy')).toBeNull();
    });
});

describe('the etag names the variant, not just the source', () =>
{
    const adapter: ImageAdapter = {
        transform: (input, options): Promise<{ data: Uint8Array; contentType: string }> =>
            Promise.resolve({ data: input.slice(0, 4), contentType: `image/${ options.format ?? 'png' }` })
    };

    it('differs across widths and formats of one source', async () =>
    {
        // A source-only tag lets a deduplicating intermediary answer one variant's conditional
        // request with another variant's bytes.
        const { app } = serve({ adapter });

        const w300 = await get(app, 'src=%2Fhero.png&w=300', { accept: 'image/webp' });
        const w640 = await get(app, 'src=%2Fhero.png&w=640', { accept: 'image/webp' });
        const avif = await get(app, 'src=%2Fhero.png&w=300', { accept: 'image/avif' });

        const tags = [w300, w640, avif].map((response) => response.headers.get('etag'));
        for (const tag of tags)
        {
            expect(tag).not.toBeNull();
        }
        expect(new Set(tags).size).toBe(3);
    });

    it('the fallback tag differs, so a recovered adapter is not 304ed into permanence', async () =>
    {
        // Fallback serves the ORIGINAL bytes under the variant url. Sharing the variant's tag
        // would make the next conditional request answer 304 once the adapter recovers, pinning
        // the client on the fallback bytes forever.
        let healthy = false;
        const flaky: ImageAdapter = {
            transform: (input): Promise<{ data: Uint8Array; contentType: string }> => healthy
                ? Promise.resolve({ data: input.slice(0, 4), contentType: 'image/webp' })
                : Promise.reject(new Error('codec exploded'))
        };
        const { app } = serve({ adapter: flaky, onError: () => undefined });

        const fallback = await get(app, 'src=%2Fhero.png&w=640', { accept: 'image/webp' });
        expect(fallback.headers.get('x-azeroth-image')).toBe('fallback');

        healthy = true;
        const revalidated = await get(app, 'src=%2Fhero.png&w=640', {
            accept: 'image/webp',
            'if-none-match': fallback.headers.get('etag') as string
        });
        expect(revalidated.status).toBe(200);
        expect(revalidated.headers.get('x-azeroth-image')).toBe('miss');
    });
});

// The endpoint's containment is the static server's rule, and only that rule: a hidden name
// stays hidden under the aliases the filesystem answers to, and `.well-known` is public.
describe('imageHandler local sources under the shared containment rule', () =>
{
    it('a Windows 8.3 short name is not a way to read a hidden file', async (context) =>
    {
        const { app, root } = serve();
        if (await realpath(join(root, 'ENV~1')).catch(() => null) === null)
        {
            context.skip();
        }
        for (const spelling of ['/ENV~1', '/env~1'])
        {
            const response = await get(app, `src=${ encodeURIComponent(spelling) }`);
            expect(response.status, spelling).toBe(404);
        }
        // Control: the alias of a PUBLIC name resolves and serves through the same lookup.
        const hero = await get(app, 'src=%2Fhero.png');
        expect(hero.status).toBe(200);
    });

    it('serves `.well-known`, the one public hidden name', async () =>
    {
        const { app, root } = serve();
        mkdirSync(join(root, '.well-known'));
        writeFileSync(join(root, '.well-known', 'logo.png'), PNG);
        const response = await get(app, `src=${ encodeURIComponent('/.well-known/logo.png') }`);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
        // While a sibling hidden directory is still refused.
        mkdirSync(join(root, '.secrets'));
        writeFileSync(join(root, '.secrets', 'logo.png'), PNG);
        expect((await get(app, `src=${ encodeURIComponent('/.secrets/logo.png') }`)).status).toBe(404);
    });
});
