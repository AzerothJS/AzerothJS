// @vitest-environment node
//
// The kit's streaming arm: a `render: 'stream'` page answers with a real streaming
// Response whose head (handoff script included) flushes before any pending data resolves,
// redirects/vetoes/HEAD stay buffered, a disconnect aborts the server fetches, and an old
// renderer that ignores the streaming request downgrades gracefully to buffered HTML.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { Suspense, createResource, h } from 'azerothjs';
import type { Route } from 'azerothjs';
import { App } from '@azerothjs/http';
import { compressResponse } from '@azerothjs/http/node';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer, type PageResult } from '@azerothjs/kit/ssr';
import { prerender } from '@azerothjs/kit/prerender';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-stream-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
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

interface Gate
{
    promise: Promise<string>;
    resolve: (value: string) => void;
}

function gate(): Gate
{
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((res) =>
    {
        resolve = res;
    });
    return { promise, resolve };
}

function streamingRig(
    pending: Gate,
    options: {
        fetcher?: () => void;
        signals?: AbortSignal[];
        guard?: Route['guard'];
        kit?: Partial<Parameters<typeof mountPages>[1]>;
    } = {}
): App
{
    const component = (): HTMLElement => h('div', {}, 'page');
    const routes: PageRoute[] = [{
        path: '/live',
        component,
        render: 'stream',
        loader: () => Promise.resolve({ greeting: 'hello' }),
        ...(options.guard !== undefined ? { guard: options.guard } : {})
    }];
    const app = (): HTMLElement =>
    {
        const data = createResource<string>((signal) =>
        {
            options.fetcher?.();
            options.signals?.push(signal);
            return pending.promise;
        });
        return h('main', {},
            h('h1', {}, 'streamed shell'),
            Suspense({
                fallback: () => h('p', {}, 'stream-loading'),
                on: [data],
                children: () => h('section', {}, () => data.data() ?? '')
            }));
    };
    const dir = makeClientDir();
    dirs.push(dir);
    const server = new App();
    mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(app, routes), ...options.kit });
    return server;
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string>
{
    const decoder = new TextDecoder();
    let out = '';
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        out += decoder.decode(value, { stream: true });
    }
    return out;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string>
{
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes(needle))
    {
        const { done, value } = await reader.read();
        expect(done).toBe(false);
        seen += decoder.decode(value, { stream: true });
    }
    return seen;
}

/**
 * Reads `response` through its content-coding and resolves with everything decoded once
 * `needle` appears, or null if `budgetMs` passes first. The budget is the point: raw bytes
 * leaving the socket early proves nothing, because the compressor can hold them in its window
 * until the stream ends. Only a DECODER seeing the shell while the slow chunk is still pending
 * distinguishes real streaming from a response that merely looks streamed in its headers.
 */
async function decodedBefore(response: Response, needle: string, budgetMs: number): Promise<string | null>
{
    const encoding = response.headers.get('content-encoding');
    const decoder = encoding === 'gzip' ? createGunzip() : new PassThrough();
    pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), decoder, () => undefined);

    let seen = '';
    return await new Promise<string | null>((resolve) =>
    {
        const timer = setTimeout(() => resolve(null), budgetMs);
        decoder.on('data', (chunk: Buffer) =>
        {
            seen += chunk.toString('utf8');
            if (seen.includes(needle))
            {
                clearTimeout(timer);
                resolve(seen);
            }
        });
        decoder.on('end', () =>
        {
            clearTimeout(timer);
            resolve(seen.includes(needle) ? seen : null);
        });
    });
}

describe('a streamed page survives compressResponse', () =>
{
    it('is compressed at all, and its shell DECODES while the slow chunk is still pending', async () =>
    {
        const pending = gate();
        const server = streamingRig(pending);
        const request = new Request('http://local/live', { headers: { 'accept-encoding': 'gzip' } });
        const compressed = compressResponse(request, await server.handle(request));

        // Kit used to mark this response `no-transform`, which compressResponse honours - so the
        // per-chunk flush it implements for exactly this case could never run on kit's own pages.
        expect(compressed.headers.get('content-encoding')).toBe('gzip');

        const early = await decodedBefore(compressed, 'stream-loading', 1000);
        expect(early).not.toBeNull();
        expect(early).toContain('streamed shell');

        pending.resolve('late-data');
    });
});

describe('render: stream over mountPages', () =>
{
    it('streams: correct headers, no content-length, head + fallback flush BEFORE data resolves', async () =>
    {
        const pending = gate();
        const server = streamingRig(pending);
        const response = await server.handle(new Request('http://local/live'));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('content-length')).toBeNull();

        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const early = await readUntil(reader, 'stream-loading');
        expect(early).toContain('</head>');
        expect(early).toContain('id="__azeroth-loader-handoff"');
        expect(early).toContain('<div id="root">');
        expect(early).toContain('streamed shell');

        pending.resolve('late-data');
        const rest = await drain(reader);
        expect(rest).toContain('late-data');
        expect(rest.trimEnd().endsWith('</html>')).toBe(true);
    });

    it('a guard redirect on a stream route stays a buffered 302 - nothing streams', async () =>
    {
        const pending = gate();
        const server = streamingRig(pending, { guard: () => ({ pathname: '/login', search: '', hash: '' }) });
        const response = await server.handle(new Request('http://local/live'));
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/login');
    });

    it('HEAD short-circuits to buffered: entity headers, empty body, and the fetcher NEVER runs', async () =>
    {
        const pending = gate();
        const fetcher = vi.fn();
        const server = streamingRig(pending, { fetcher });
        const response = await server.handle(new Request('http://local/live', { method: 'HEAD' }));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('cancelling the response body aborts the in-flight server fetch', async () =>
    {
        const pending = gate();
        const signals: AbortSignal[] = [];
        const server = streamingRig(pending, { signals });
        const response = await server.handle(new Request('http://local/live'));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        await readUntil(reader, 'stream-loading');
        await reader.cancel();
        expect(signals[0]?.aborted).toBe(true);
    });

    it('an old renderer that ignores the streaming request downgrades to buffered html', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const component = (): HTMLElement => (undefined as unknown as HTMLElement);
        const oldRenderer = (url: string, shell: string): Promise<PageResult> =>
            Promise.resolve({ kind: 'html', status: 200, html: shell.replace('<div id="root"></div>', `<div id="root">BUFFERED:${ url }</div>`) });
        const server = new App();
        mountPages(server, {
            routes: [{ path: '/live', component, render: 'stream' }],
            clientDir: dir,
            renderer: oldRenderer
        });
        const response = await server.handle(new Request('http://local/live'));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('BUFFERED:/live');
    });

    it('a stream route with no renderer serves the shell; prerender writes nothing for it', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const component = (): HTMLElement => (undefined as unknown as HTMLElement);
        const routes: PageRoute[] = [{ path: '/live', component, render: 'stream' }];
        const server = new App();
        mountPages(server, { routes, clientDir: dir });
        const response = await server.handle(new Request('http://local/live'));
        expect(await response.text()).toContain('<div id="root"></div>');

        const written = await prerender({
            routes,
            clientDir: dir,
            renderer: (_url, shell) => Promise.resolve({ kind: 'html', status: 200, html: shell })
        });
        expect(written).toEqual([]);
    });
});

describe('CSP nonce plumbing', () =>
{
    // Streaming emits INLINE scripts (the swap runtime plus one call per boundary). Under any
    // `script-src` without 'unsafe-inline' a browser blocks them, every boundary stays on its
    // fallback until hydration refetches, and the streamed bytes are wasted - streaming ends up
    // SLOWER than buffering. `renderToStream` always accepted a nonce, but kit had no way to
    // pass one, so no app behind a strict CSP could use the feature at all. Proven in Chrome
    // against a real scaffold before this existed: 3 CSP violations, `window.__AZS` undefined.
    it('stamps the per-request nonce on every inline script a streamed page emits', async () =>
    {
        const pending = gate();
        const seen: Array<string | undefined> = [];
        const server = streamingRig(pending, {
            kit: {
                scriptNonce: (context) =>
                {
                    const nonce = context.request.headers.get('x-test-nonce') ?? undefined;
                    seen.push(nonce);
                    return nonce;
                }
            }
        });

        const response = await server.handle(new Request('http://local/live', { headers: { 'x-test-nonce': 'NONCE123' } }));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        await readUntil(reader, 'stream-loading');
        pending.resolve('nonce-check');
        const rest = await drain(reader);

        expect(seen).toEqual(['NONCE123']);
        // Every inline <script> the stream emits must carry it, or the CSP blocks that one.
        const inlineScripts = [...rest.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((match) => match[0]);
        expect(inlineScripts.length).toBeGreaterThan(0);
        for (const tag of inlineScripts)
        {
            // The seed payload is `type="application/json"` - inert data, not executed, so a CSP
            // never blocks it and it needs no nonce.
            if (tag.includes('application/json'))
            {
                continue;
            }
            expect(tag).toContain('nonce="NONCE123"');
        }
    });

    it('omits the attribute entirely when no nonce provider is configured', async () =>
    {
        const pending = gate();
        const server = streamingRig(pending);
        const response = await server.handle(new Request('http://local/live'));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        await readUntil(reader, 'stream-loading');
        pending.resolve('no-nonce');
        const rest = await drain(reader);
        expect(rest).not.toContain('nonce=');
    });
});
