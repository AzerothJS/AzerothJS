// @vitest-environment node
//
// Static file serving, driven through the REAL stack (app.handle + a wildcard route) so the
// traversal tests exercise exactly what production sees: URL normalization first, the
// router's per-segment percent-decoding second, the handler's containment check last. The
// fixture tree deliberately keeps a secret.txt OUTSIDE the served root - every traversal
// spelling must fail to reach it.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App } from '../src/app.ts';
import { staticFiles, contentTypeFor } from '../src/static.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'static');

function appWith(options: Parameters<typeof staticFiles>[1] = {}): App
{
    const app = new App();
    const handler = staticFiles(root, options);
    // The documented mount pattern: the wildcard for files, the bare pattern for the root
    // index (a wildcard requires at least one segment by the router's semantics).
    app.get('/assets/*path', handler);
    app.get('/assets', handler);
    return app;
}

function get(app: App, target: string, init: RequestInit = {}): Promise<Response>
{
    return app.handle(new Request(`http://local${ target }`, init));
}

describe('serving files', () =>
{
    it('serves a file with its content type, etag, and cache-control', async () =>
    {
        const response = await get(appWith(), '/assets/styles.css');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
        expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
        expect(await response.text()).toBe('body { color: teal }');
    });

    it('serves binary bytes exactly', async () =>
    {
        const response = await get(appWith(), '/assets/data.bin');
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 1, 254, 13, 10, 0]);
    });

    it('resolves a directory to its index file', async () =>
    {
        const response = await get(appWith(), '/assets/');
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(await response.text()).toContain('home');
    });

    it('serves nested files', async () =>
    {
        expect(await (await get(appWith(), '/assets/sub/page.html')).text()).toContain('sub page');
    });

    it('a missing file is the standard 404 wire shape', async () =>
    {
        const response = await get(appWith(), '/assets/absent.css');
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string; message: string } }).error.code).toBe('not-found');
    });

    it('a custom cache policy applies (the hashed-assets mount)', async () =>
    {
        const response = await get(appWith({ cacheControl: 'public, max-age=31536000, immutable' }), '/assets/styles.css');
        expect(response.headers.get('cache-control')).toContain('immutable');
    });
});

describe('conditional requests', () =>
{
    it('returns 304 with an empty body on an If-None-Match hit', async () =>
    {
        const app = appWith();
        const first = await get(app, '/assets/styles.css');
        const etag = first.headers.get('etag')!;

        const second = await get(app, '/assets/styles.css', { headers: { 'if-none-match': etag } });
        expect(second.status).toBe(304);
        expect(second.body).toBeNull();
        expect(second.headers.get('etag')).toBe(etag);
    });

    it('a stale validator gets the full body again', async () =>
    {
        const response = await get(appWith(), '/assets/styles.css', { headers: { 'if-none-match': '"0-0"' } });
        expect(response.status).toBe(200);
    });

    it('If-Modified-Since answers 304 - every conforming cache and `curl -z` sends one', async () =>
    {
        const app = appWith();
        const probe = await get(app, '/assets/styles.css');
        const lastModified = probe.headers.get('last-modified')!;

        const unchanged = await get(app, '/assets/styles.css', { headers: { 'if-modified-since': lastModified } });
        expect(unchanged.status).toBe(304);
        expect(unchanged.body).toBeNull();

        const later = await get(app, '/assets/styles.css', { headers: { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() } });
        expect(later.status).toBe(304);
    });

    it('a date OLDER than the file, or an unparseable one, gets the full body', async () =>
    {
        const stale = await get(appWith(), '/assets/styles.css', { headers: { 'if-modified-since': new Date(0).toUTCString() } });
        expect(stale.status).toBe(200);

        const garbage = await get(appWith(), '/assets/styles.css', { headers: { 'if-modified-since': 'not a date' } });
        expect(garbage.status).toBe(200);
    });

    it('If-None-Match keeps precedence: a stale tag beats a fresh date', async () =>
    {
        const app = appWith();
        const lastModified = (await get(app, '/assets/styles.css')).headers.get('last-modified')!;
        const response = await get(app, '/assets/styles.css', {
            headers: { 'if-none-match': '"0-0"', 'if-modified-since': lastModified }
        });
        expect(response.status).toBe(200);
    });
});

describe('range requests (single-range; styles.css is the 20-byte "body { color: teal }")', () =>
{
    it('every 200 advertises accept-ranges and last-modified', async () =>
    {
        const response = await get(appWith(), '/assets/styles.css');
        expect(response.headers.get('accept-ranges')).toBe('bytes');
        expect(response.headers.get('last-modified')).toMatch(/GMT$/);
    });

    it('bytes=0-3 gets a 206 with exactly that span and the total in content-range', async () =>
    {
        const response = await get(appWith(), '/assets/styles.css', { headers: { range: 'bytes=0-3' } });
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe('bytes 0-3/20');
        expect(response.headers.get('content-length')).toBe('4');
        expect(await response.text()).toBe('body');
    });

    it('an open-ended range streams to the end; a suffix range takes the tail', async () =>
    {
        const open = await get(appWith(), '/assets/styles.css', { headers: { range: 'bytes=7-' } });
        expect(open.status).toBe(206);
        expect(await open.text()).toBe('color: teal }');

        const suffix = await get(appWith(), '/assets/styles.css', { headers: { range: 'bytes=-6' } });
        expect(suffix.status).toBe(206);
        expect(suffix.headers.get('content-range')).toBe('bytes 14-19/20');
        expect(await suffix.text()).toBe('teal }');
    });

    it('range slices are BYTE ranges, exact on binary content', async () =>
    {
        const response = await get(appWith(), '/assets/data.bin', { headers: { range: 'bytes=2-4' } });
        expect(response.status).toBe(206);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 254, 13]);
    });

    it('an end past the file clamps; a start past the file is a 416 with the total size', async () =>
    {
        const clamped = await get(appWith(), '/assets/styles.css', { headers: { range: 'bytes=14-9999' } });
        expect(clamped.status).toBe(206);
        expect(clamped.headers.get('content-range')).toBe('bytes 14-19/20');

        const past = await get(appWith(), '/assets/styles.css', { headers: { range: 'bytes=20-' } });
        expect(past.status).toBe(416);
        expect(past.headers.get('content-range')).toBe('bytes */20');
    });

    it('multi-range and malformed Range headers are IGNORED - the full 200 answers', async () =>
    {
        for (const header of ['bytes=0-3,5-9', 'bytes=abc', 'chars=0-3', 'bytes=5-2'])
        {
            const response = await get(appWith(), '/assets/styles.css', { headers: { range: header } });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('body { color: teal }');
        }
    });

    it('If-Range with the current validator honors the range; a stale one gets the full file', async () =>
    {
        const app = appWith();
        const probe = await get(app, '/assets/styles.css');
        const etag = probe.headers.get('etag')!;
        const lastModified = probe.headers.get('last-modified')!;

        const fresh = await get(app, '/assets/styles.css', { headers: { range: 'bytes=0-3', 'if-range': etag } });
        expect(fresh.status).toBe(206);

        const freshByDate = await get(app, '/assets/styles.css', { headers: { range: 'bytes=0-3', 'if-range': lastModified } });
        expect(freshByDate.status).toBe(206);

        const stale = await get(app, '/assets/styles.css', { headers: { range: 'bytes=0-3', 'if-range': '"0-0"' } });
        expect(stale.status).toBe(200);
        expect(await stale.text()).toBe('body { color: teal }');
    });

    it('If-None-Match still wins over Range - a cache hit is a 304, not a 206', async () =>
    {
        const app = appWith();
        const etag = (await get(app, '/assets/styles.css')).headers.get('etag')!;
        const response = await get(app, '/assets/styles.css', { headers: { range: 'bytes=0-3', 'if-none-match': etag } });
        expect(response.status).toBe(304);
    });
});

describe('traversal safety: secret.txt sits one level ABOVE the root', () =>
{
    it('percent-encoded dot segments cannot escape (the router decodes them per segment)', async () =>
    {
        // URL parsing normalizes a literal `..`, so the live attack vector is the encoded
        // form arriving intact at the router: %2e%2e -> `..` as a wildcard segment value.
        const response = await get(appWith(), '/assets/%2e%2e/secret.txt');
        expect(response.status).toBe(404);
    });

    it('an encoded slash + dots smuggled INSIDE one segment cannot escape either', async () =>
    {
        const response = await get(appWith(), '/assets/%2e%2e%2fsecret.txt');
        expect(response.status).toBe(404);
    });

    it('null bytes are rejected', async () =>
    {
        const response = await get(appWith(), '/assets/styles.css%00.html');
        expect(response.status).toBe(404);
    });

    it('an absolute path in the wildcard cannot re-root the lookup', async () =>
    {
        const outside = path.join(root, '..', 'secret.txt');
        const response = await get(appWith(), `/assets/${ encodeURIComponent(outside) }`);
        expect(response.status).toBe(404);
    });

    it('the denial is indistinguishable from a plain missing file (no 403 information leak)', async () =>
    {
        const traversal = await get(appWith(), '/assets/%2e%2e/secret.txt');
        const missing = await get(appWith(), '/assets/never-existed.txt');
        expect(traversal.status).toBe(missing.status);
        expect(((await traversal.json()) as { error: { code: string; message: string } }).error.code).toBe(((await missing.json()) as { error: { code: string; message: string } }).error.code);
    });
});

describe('hidden files stay hidden under every spelling the filesystem answers to', () =>
{
    /** A throwaway root holding what a leak actually costs: a .env and a .git. */
    async function secretRoot(): Promise<string>
    {
        const root = await mkdtemp(path.join(tmpdir(), 'azeroth-static-'));
        await writeFile(path.join(root, '.env'), 'DB_PASSWORD=hunter2');
        await mkdir(path.join(root, '.git'));
        await writeFile(path.join(root, '.git', 'config'), '[remote "origin"]');
        await writeFile(path.join(root, 'public.txt'), 'nothing secret');
        return root;
    }

    function appAt(root: string, options: Parameters<typeof staticFiles>[1] = {}): App
    {
        const app = new App();
        app.get('/assets/*path', staticFiles(root, options));
        return app;
    }

    it('a Windows 8.3 short name is not a way around the dotfile rule', async (context) =>
    {
        const root = await secretRoot();
        // 8.3 alias generation is a per-volume Windows setting: where it is off there is no
        // alias to attack, and nothing here to assert.
        if (await realpath(path.join(root, 'ENV~1')).catch(() => null) === null)
        {
            context.skip();
        }

        const app = appAt(root);
        // Case-insensitive and encoding-agnostic: the router decodes the segment, the
        // filesystem resolves the alias, and stat/createReadStream honor both.
        for (const spelling of ['.env', 'ENV~1', 'env~1', '%45NV~1'])
        {
            const response = await get(app, `/assets/${ spelling }`);
            expect(response.status, spelling).toBe(404);
        }
        expect((await get(app, '/assets/GIT~1/config')).status).toBe(404);
        expect((await get(app, '/assets/public.txt')).status).toBe(200);
    });

    it('dotfiles: true opts back in, alias and all', async (context) =>
    {
        const root = await secretRoot();
        if (await realpath(path.join(root, 'ENV~1')).catch(() => null) === null)
        {
            context.skip();
        }

        const app = appAt(root, { dotfiles: true });
        expect(await (await get(app, '/assets/.env')).text()).toContain('hunter2');
        expect(await (await get(app, '/assets/ENV~1')).text()).toContain('hunter2');
    });
});

describe('contentTypeFor', () =>
{
    it('maps the web asset set and defaults to octet-stream', () =>
    {
        expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
        expect(contentTypeFor('font.WOFF2')).toBe('font/woff2');
        expect(contentTypeFor('archive.xyz')).toBe('application/octet-stream');
    });
});
