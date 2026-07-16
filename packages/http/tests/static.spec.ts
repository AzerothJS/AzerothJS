// @vitest-environment node
//
// Static file serving, driven through the REAL stack (app.handle + a wildcard route) so the
// traversal tests exercise exactly what production sees: URL normalization first, the
// router's per-segment percent-decoding second, the handler's containment check last. The
// fixture tree deliberately keeps a secret.txt OUTSIDE the served root - every traversal
// spelling must fail to reach it.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
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

describe('contentTypeFor', () =>
{
    it('maps the web asset set and defaults to octet-stream', () =>
    {
        expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
        expect(contentTypeFor('font.WOFF2')).toBe('font/woff2');
        expect(contentTypeFor('archive.xyz')).toBe('application/octet-stream');
    });
});
