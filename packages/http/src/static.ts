/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * File serving with traversal safety, etags, and conditional requests.
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
 *     the body never opened, and If-Modified-Since answers the same way (second precision,
 *     which is all an HTTP-date carries) when no entity tag was offered.
 *   - STREAMING. Files stream to the response (no full-file buffering), riding the adapter's
 *     backpressure loop.
 *
 *   - RANGE REQUESTS. Single-range `bytes=` requests get a 206 streaming exactly the span
 *     (video seeking, download resume); an unsatisfiable range is a 416 with the total
 *     size. Multi-range requests are answered with the FULL 200 - RFC 9110 permits
 *     ignoring Range, and multipart/byteranges complexity buys real clients nothing
 *     (browsers and download managers issue single ranges). If-Range holds: a stale
 *     validator (ETag or Last-Modified date) downgrades to the full 200 so a resumed
 *     download never splices two versions of a file.
 *
 * Directory requests resolve to `index` (default index.html) when present.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import type { Handler } from './app.ts';
import { containedFile, type ContainedFile } from './contained-file.ts';
import { matchesEtag, notModified, withRepresentationMetadata } from './conditional.ts';
import { negotiateEncodings } from './content-coding.ts';
import { NotFoundError } from './errors.ts';
import { webStreamOf } from './web-stream.ts';

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

/**
 * Options for the static file server: the root it can never escape, index/extension fallbacks,
 * cache policy, and range support. Traversal safety is not configurable - every resolved path
 * is verified to stay under `root` regardless of what these say.
 */
export interface StaticOptions
{
    /**
     * The Cache-Control header value. The default demands revalidation (correct for
     * unhashed files); hashed build assets should mount a second handler with
     * 'public, max-age=31536000, immutable'.
     */
    cacheControl?: string;

    /**
     * Negotiate fresh .br or .gz siblings beside the requested file. The default serves
     * the original. Range requests use the original byte offsets.
     */
    precompressed?: boolean;

    /** The file served when the path resolves to a directory (default 'index.html'). */
    index?: string;

    /**
     * The wildcard param carrying the relative path (default 'path'). With no such param
     * (a non-wildcard route), the whole route is one fixed file - `index` is served.
     */
    param?: string;

    /**
     * Serve dotfiles (a path segment beginning with `.`). Default `false`: a request for
     * `/.env`, `/.git/config`, or any hidden file is a 404. `.well-known/` is ALWAYS served
     * regardless (RFC 8615 reserves it as a public path for ACME, security.txt, etc.). Set
     * `true` only when the root deliberately contains servable hidden files.
     *
     * The rule is enforced on the RESOLVED path, not just the requested one: a filesystem
     * alias that spells a hidden name differently (a Windows 8.3 short name such as `ENV~1`
     * for `.env`, an in-root symlink) is denied the same way.
     */
    dotfiles?: boolean;
}

/**
 * Builds the file-serving handler for `rootDir`. The root is resolved once, at boot - a
 * relative root binds to the process working directory at startup, not per request.
 */
export function staticFiles(rootDir: string, options: StaticOptions = {}): Handler
{
    const root = resolve(rootDir);
    // The root's REAL path (symlinks resolved), resolved ONCE and cached: a served file's
    // realpath must stay under it, so a symlink INSIDE the root pointing outside cannot leak
    // arbitrary files. Resolved lazily via the SAME async realpath the per-request check uses
    // (a sync/async mismatch expands Windows 8.3 short names inconsistently), and falls back
    // to the logical root if it does not exist.
    let realRootPromise: Promise<string> | null = null;
    const getRealRoot = (): Promise<string> => (realRootPromise ??= realpath(root).catch(() => root));
    const cacheControl = options.cacheControl ?? 'public, max-age=0, must-revalidate';
    const index = options.index ?? 'index.html';
    const param = options.param ?? 'path';
    const dotfiles = options.dotfiles === true;
    const precompressed = options.precompressed === true
        && !cacheControl.split(',').some(directive => directive.trim().toLowerCase() === 'no-transform');

    return async (context) =>
    {
        const requested = context.params[param] ?? '';
        const realRoot = await getRealRoot();
        const found = await containedFile(root, requested, { index, dotfiles, realRoot });
        if (found === null)
        {
            throw new NotFoundError();
        }
        const request = context.request;
        const canVary = precompressed && !/\.(?:br|gz)$/i.test(found.path);
        const variant = canVary && !request.headers.has('range')
            ? await selectSibling(root, realRoot, found, dotfiles, request.headers.get('accept-encoding'))
            : undefined;
        const { path: target, stats: info } = variant?.file ?? found;

        // Include the file identity to distinguish negotiated files with equal size and mtime.
        // An encoder can replace a sibling while preserving both values, so its tag also
        // includes the filesystem change time and the selected coding.
        const identity = createHash('sha256').update(target.slice(root.length).replaceAll('\\', '/')).digest('hex').slice(0, 8);
        const suffix = variant === undefined ? '' : `-${ info.ctimeMs.toString(16) }-stored-${ variant.coding }`;
        const etag = `"${ info.size.toString(16) }-${ Math.trunc(info.mtimeMs).toString(16) }-${ identity }${ suffix }"`;
        const lastModified = new Date(info.mtimeMs).toUTCString();
        const headers = new Headers({
            'content-type': contentTypeFor(found.path),
            'content-length': String(info.size),
            'cache-control': cacheControl,
            'last-modified': lastModified,
            etag
        });
        if (canVary)
        {
            headers.set('vary', 'accept-encoding');
        }
        if (variant === undefined)
        {
            headers.set('accept-ranges', 'bytes');
        }
        else
        {
            headers.set('content-encoding', variant.coding);
        }

        const ifNoneMatch = request.headers.get('if-none-match');
        if (matchesEtag(ifNoneMatch, etag))
        {
            return notModified(headers);
        }

        // An HTTP-date is the weaker validator, so it only speaks when the client offered no
        // entity tag (RFC 9110 13.1.3). Dates carry whole seconds, which is why the file's
        // mtime is truncated to seconds before the comparison.
        const ifModifiedSince = ifNoneMatch === null ? context.request.headers.get('if-modified-since') : null;
        if (ifModifiedSince !== null)
        {
            const since = Date.parse(ifModifiedSince);
            if (!Number.isNaN(since) && Math.trunc(info.mtimeMs / 1000) <= Math.trunc(since / 1000))
            {
                return notModified(headers);
            }
        }

        const range = rangeFor(request, info.size, etag, lastModified);
        if (range === 'unsatisfiable')
        {
            headers.delete('content-length');
            headers.set('content-range', `bytes */${ info.size }`);
            return new Response(null, { status: 416, headers });
        }
        if (range !== null)
        {
            headers.set('content-range', `bytes ${ range.start }-${ range.end }/${ info.size }`);
            headers.set('content-length', String(range.end - range.start + 1));
            const span = request.method === 'HEAD' ? null : webStreamOf(createReadStream(target, range));
            return new Response(span, { status: 206, headers });
        }

        if (request.method === 'HEAD')
        {
            return withRepresentationMetadata(new Response(null, { status: 200, headers }));
        }
        return new Response(webStreamOf(createReadStream(target)), { status: 200, headers });
    };
}

/** Chooses the highest-ranked fresh stored representation of this exact admitted file. */
async function selectSibling(
    root: string, realRoot: string, original: ContainedFile, dotfiles: boolean, acceptEncoding: string | null
): Promise<{ file: ContainedFile; coding: 'br' | 'gzip' } | undefined>
{
    for (const coding of negotiateEncodings(acceptEncoding ?? ''))
    {
        if (coding === 'deflate')
        {
            continue;
        }
        const sibling = relative(root, original.path) + (coding === 'br' ? '.br' : '.gz');
        const file = await containedFile(root, sibling, { realRoot, dotfiles });
        if (file !== null && file.stats.mtimeMs >= original.stats.mtimeMs)
        {
            return { file, coding };
        }
    }
    return undefined;
}

/** The byte span to serve, null for the full file, or an unsatisfiable range. */
function rangeFor(
    request: Request, size: number, etag: string, lastModified: string
): { start: number; end: number } | 'unsatisfiable' | null
{
    const header = request.headers.get('range');
    if (header === null)
    {
        return null;
    }

    // If-Range: serve the range only against the exact entity the client already holds -
    // a changed file must arrive whole, or a resumed download splices two versions.
    const ifRange = request.headers.get('if-range');
    if (ifRange !== null && ifRange !== etag && ifRange !== lastModified)
    {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null)
    {
        return null;
    }
    const [, first, last] = match;

    if (first === '')
    {
        // Suffix form: the final N bytes.
        if (last === '' || last === '0')
        {
            return last === '0' ? 'unsatisfiable' : null;
        }
        const span = Math.min(Number(last), size);
        return size === 0 ? 'unsatisfiable' : { start: size - span, end: size - 1 };
    }

    const start = Number(first);
    if (start >= size)
    {
        return 'unsatisfiable';
    }
    const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    if (end < start)
    {
        return null;
    }
    return { start, end };
}
