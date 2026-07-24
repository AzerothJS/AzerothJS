/**
 * MODULE: http/static - file serving with traversal safety, etags, and conditional requests
 *
 * `staticFiles(root)` returns a Handler for a wildcard route. A wildcard needs at least one
 * segment (the router's documented semantics), so a mount that should also answer at its own
 * root registers the bare pattern too - same handler, two lines:
 *
 *     const assets = staticFiles('./public');
 *     app.get('/assets/*path', assets);
 *     app.get('/assets', assets);       // serves ./public/index.html
 *
 * The non-negotiables live here, not in user code:
 *
 *   - TRAVERSAL SAFETY. The requested path is resolved against the root and must stay under
 *     it - checked on the RESOLVED string, so `..` segments, encoded slashes the router
 *     already decoded, and absolute-path tricks all fail the same prefix test. Null bytes
 *     are rejected outright. A denied path is a 404, never a 403: "exists but forbidden"
 *     is itself an information leak.
 *   - CONDITIONAL REQUESTS. Every file gets a strong ETag derived from (size, mtime) - cheap,
 *     stable, and correct for whole-file responses. An If-None-Match hit returns 304 with
 *     the body never opened.
 *   - STREAMING. Files stream to the response (no full-file buffering), riding the adapter's
 *     backpressure loop.
 *
 * Range requests are deliberately absent for now: correct Range support (multipart ranges,
 * If-Range interaction) is its own unit and arrives with the media-serving story. Directory
 * requests resolve to `index` (default index.html) when present.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Handler } from './app.ts';
import { NotFoundError } from './errors.ts';

/** The extension -> Content-Type map for what a web app actually serves. */
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf'
};

/** The Content-Type served for `path`, by extension (octet-stream when unknown). */
export function contentTypeFor(path: string): string
{
    return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticOptions
{
    /**
     * The Cache-Control header value. The default demands revalidation (correct for
     * unhashed files); hashed build assets should mount a second handler with
     * 'public, max-age=31536000, immutable'.
     */
    cacheControl?: string;

    /** The file served when the path resolves to a directory (default 'index.html'). */
    index?: string;

    /**
     * The wildcard param carrying the relative path (default 'path'). With no such param
     * (a non-wildcard route), the whole route is one fixed file - `index` is served.
     */
    param?: string;
}

/**
 * Builds the file-serving handler for `rootDir`. The root is resolved once, at boot - a
 * relative root binds to the process working directory at startup, not per request.
 */
export function staticFiles(rootDir: string, options: StaticOptions = {}): Handler
{
    const root = resolve(rootDir);
    const cacheControl = options.cacheControl ?? 'public, max-age=0, must-revalidate';
    const index = options.index ?? 'index.html';
    const param = options.param ?? 'path';

    return async (context) =>
    {
        const relative = context.params[param] ?? '';
        if (relative.includes('\0'))
        {
            throw new NotFoundError();
        }

        // Resolve, then verify containment on the resolved string. Everything the router
        // decoded (including smuggled separators) is already literal here, so the one
        // prefix check covers every traversal spelling.
        let target = resolve(root, relative);
        if (target !== root && !target.startsWith(root + sep))
        {
            throw new NotFoundError();
        }

        let info = await stat(target).catch(() => null);
        if (info?.isDirectory() === true)
        {
            target = join(target, index);
            info = await stat(target).catch(() => null);
        }
        if (info === null || !info.isFile())
        {
            throw new NotFoundError();
        }

        // A strong validator from (size, mtime): whole-file responses cannot differ without
        // one of the two changing on any sane filesystem.
        const etag = `"${ info.size.toString(16) }-${ Math.trunc(info.mtimeMs).toString(16) }"`;
        const headers = new Headers({
            'content-type': contentTypeFor(target),
            'cache-control': cacheControl,
            etag
        });

        if (context.request.headers.get('if-none-match') === etag)
        {
            return new Response(null, { status: 304, headers });
        }

        headers.set('content-length', String(info.size));
        const body = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
        return new Response(body, { status: 200, headers });
    };
}
