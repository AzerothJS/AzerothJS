/**
 * MODULE: kit/image - the transform endpoint behind <Image>
 *
 * GET /_image?src&w&q answers content-addressed image bytes: every parameter (source
 * content hash, snapped width, quality, negotiated format) rides the cache key, so the
 * response headers can promise a year of immutability without ever serving a stale
 * transform. The adapter seam carries the actual pixel work: the framework ships NO codec
 * and NO codec dependency - an app that wants transforms implements {@link ImageAdapter}
 * with whatever it already trusts, and no adapter at all still yields a caching
 * passthrough (original bytes, negotiated nothing). A broken adapter degrades to the
 * original bytes uncached - a page with a heavy image beats a page with a blank one.
 *
 * Local sources resolve under `root` with the same two-step containment static file
 * serving uses (logical prefix + realpath); remote sources need an exact-origin
 * allowlist and are fetched with a byte cap and timeout.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { BadRequestError, ForbiddenError, NotFoundError, matchesEtag } from '@azerothjs/http';
import type { Handler } from '@azerothjs/http';

import type { KitErrorObserver } from './isr.ts';

/** The width ladder - MIRRORS azerothjs's DEVICE_WIDTHS (a comment there ties the two). */
const DEVICE_WIDTHS: readonly number[] = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];

/** The pixel-work seam. Implementations receive original bytes and produce the variant. */
export interface ImageAdapter
{
    transform(input: Uint8Array, options: { width?: number; quality?: number; format?: 'avif' | 'webp' }): Promise<{ data: Uint8Array; contentType: string }>;
}

/** One cached transform result. */
export interface ImageCacheEntry
{
    data: Uint8Array;
    contentType: string;
}

/** Where transforms live. Any internal failure must read as a miss. */
export interface ImageCache
{
    get(key: string): Promise<ImageCacheEntry | undefined>;
    set(key: string, entry: ImageCacheEntry): Promise<void>;
}

/** The in-process default: a byte-budgeted map evicting insertion-first. */
export class MemoryImageCache implements ImageCache
{
    readonly #entries = new Map<string, ImageCacheEntry>();

    readonly #maxBytes: number;

    #bytes = 0;

    constructor(options: { maxBytes?: number } = {})
    {
        this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    }

    public get(key: string): Promise<ImageCacheEntry | undefined>
    {
        return Promise.resolve(this.#entries.get(key));
    }

    public set(key: string, entry: ImageCacheEntry): Promise<void>
    {
        const existing = this.#entries.get(key);
        if (existing !== undefined)
        {
            this.#bytes -= existing.data.byteLength;
            this.#entries.delete(key);
        }
        while (this.#bytes + entry.data.byteLength > this.#maxBytes && this.#entries.size > 0)
        {
            const oldest = this.#entries.keys().next();
            if (oldest.done === true)
            {
                break;
            }
            this.#bytes -= (this.#entries.get(oldest.value) as ImageCacheEntry).data.byteLength;
            this.#entries.delete(oldest.value);
        }
        this.#entries.set(key, entry);
        this.#bytes += entry.data.byteLength;
        return Promise.resolve();
    }
}

/** Everything {@link imageHandler} needs. */
export interface ImageHandlerOptions
{
    /** Local sources resolve under this directory and can never escape it. */
    root: string;

    /** The pixel-work seam; absent = caching passthrough of original bytes. */
    adapter?: ImageAdapter;

    /** Transform cache (default: one in-process {@link MemoryImageCache}). */
    cache?: ImageCache;

    /** Remote origins (scheme://host[:port], exact) allowed as sources. Default: none. */
    allowedOrigins?: readonly string[];

    /** Largest source the endpoint will read, in bytes (default 25 MiB). */
    maxSourceBytes?: number;

    /**
     * The success Cache-Control (default a year, immutable). CAVEAT: the URL carries no
     * content hash, so replacing an image IN PLACE at the same path stays stale in
     * browsers for up to a year - apps with mutable images lower this.
     */
    cacheControl?: string;

    /** Hears adapter failures (the fallback path). */
    onError?: KitErrorObserver;

    /** Test seam for remote fetches (mirrors the api client's `fetch` option). */
    fetchImpl?: (request: Request) => Promise<Response>;
}

/** @internal Extension -> content type for the passthrough path. */
const CONTENT_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon'
};

/** @internal A dot-leading segment anywhere in the path (the static-serving policy). */
function hasDotSegment(path: string): boolean
{
    for (const segment of path.split(/[/\\]/))
    {
        if (segment.startsWith('.'))
        {
            return true;
        }
    }
    return false;
}

/** @internal The smallest ladder width >= value; null when the request is out of range. */
function snapWidth(raw: string | null): number | null | undefined
{
    if (raw === null)
    {
        return undefined;
    }
    const value = Number(raw);
    const top = DEVICE_WIDTHS[DEVICE_WIDTHS.length - 1] as number;
    if (!Number.isInteger(value) || value <= 0 || value > top)
    {
        return null;
    }
    for (const width of DEVICE_WIDTHS)
    {
        if (width >= value)
        {
            return width;
        }
    }
    return top;
}

/** Builds the GET /_image handler. Register it BEFORE any wildcard asset fallback. */
export function imageHandler(options: ImageHandlerOptions): Handler
{
    const cache = options.cache ?? new MemoryImageCache();
    const allowed = new Set(options.allowedOrigins ?? []);
    const maxSourceBytes = options.maxSourceBytes ?? 25 * 1024 * 1024;
    const cacheControl = options.cacheControl ?? 'public, max-age=31536000, immutable';
    const onError = options.onError ?? ((error, context): void =>
    {
        console.error(`kit ${ context.phase } failed for ${ context.path }:`, error);
    });
    const transport = options.fetchImpl ?? ((request: Request): Promise<Response> => fetch(request));
    const inflight = new Map<string, Promise<ImageCacheEntry>>();
    // Source-bytes hashes memoized by identity (path + size + mtime), so an unchanged
    // file is hashed once, not per variant.
    const sourceHashes = new Map<string, string>();

    async function readLocal(source: string): Promise<{ bytes: Uint8Array; hash: string; contentType: string }>
    {
        if (source.includes('\0') || hasDotSegment(source))
        {
            throw new NotFoundError();
        }
        const root = resolve(options.root);
        const target = resolve(root, source.slice(1));
        if (target !== root && !target.startsWith(root + sep))
        {
            throw new NotFoundError();
        }
        const info = await stat(target).catch(() => null);
        if (info === null || !info.isFile())
        {
            throw new NotFoundError();
        }
        if (info.size > maxSourceBytes)
        {
            throw new BadRequestError('Source image exceeds the size limit.', { code: 'image-too-large' });
        }
        // The logical check above cannot see symlinks; the real path can. Real compares
        // against real - Windows hands out 8.3 aliases the logical root never matches.
        const realRoot = await realpath(root).catch(() => null);
        const real = await realpath(target).catch(() => null);
        if (realRoot === null || real === null || (real !== realRoot && !real.startsWith(realRoot + sep)))
        {
            throw new NotFoundError();
        }
        const identity = `${ target }:${ info.size }:${ info.mtimeMs }`;
        const bytes = new Uint8Array(await readFile(target));
        let hash = sourceHashes.get(identity);
        if (hash === undefined)
        {
            hash = createHash('sha256').update(bytes).digest('hex');
            sourceHashes.set(identity, hash);
        }
        const extension = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
        return { bytes, hash, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' };
    }

    async function readRemote(source: string): Promise<{ bytes: Uint8Array; hash: string; contentType: string }>
    {
        const url = new URL(source);
        if (!allowed.has(url.origin))
        {
            throw new ForbiddenError('Remote image origin is not allowlisted.', { code: 'image-origin' });
        }
        const response = await transport(new Request(source, { signal: AbortSignal.timeout(10_000) }));
        if (!response.ok)
        {
            throw new BadRequestError(`Remote image answered ${ response.status }.`, { code: 'image-upstream' });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxSourceBytes)
        {
            throw new BadRequestError('Remote image exceeds the size limit.', { code: 'image-too-large' });
        }
        return {
            bytes,
            hash: createHash('sha256').update(bytes).digest('hex'),
            contentType: response.headers.get('content-type') ?? 'application/octet-stream'
        };
    }

    return async (context) =>
    {
        const query = context.url.searchParams;
        const source = query.get('src');
        if (source === null || source === '')
        {
            throw new BadRequestError('src is required.', { code: 'bad-image-params' });
        }
        const width = snapWidth(query.get('w'));
        if (width === null)
        {
            throw new BadRequestError('w must be a positive integer within the ladder.', { code: 'bad-image-params' });
        }
        const qualityRaw = query.get('q');
        const quality = qualityRaw === null ? 75 : Number(qualityRaw);
        if (!Number.isInteger(quality) || quality < 1 || quality > 100)
        {
            throw new BadRequestError('q must be an integer from 1 to 100.', { code: 'bad-image-params' });
        }

        const remote = source.startsWith('http://') || source.startsWith('https://');
        if (!remote && !source.startsWith('/'))
        {
            throw new BadRequestError('src must be a leading-slash local path or an https URL.', { code: 'bad-image-params' });
        }
        const original = remote ? await readRemote(source) : await readLocal(source);

        // Format: negotiated from Accept, only when an adapter can actually produce it.
        const accept = context.request.headers.get('accept') ?? '';
        const format = options.adapter === undefined
            ? undefined
            : accept.includes('image/avif')
                ? 'avif' as const
                : accept.includes('image/webp')
                    ? 'webp' as const
                    : undefined;

        const transformed = options.adapter !== undefined && (format !== undefined || width !== undefined);
        const key = `v1:${ original.hash }:${ width ?? '' }:${ quality }:${ format ?? '' }`;
        const respond = (entry: ImageCacheEntry, verdict: 'hit' | 'miss' | 'passthrough' | 'fallback'): Response =>
        {
            const etag = `"${ key.slice(3, 35) }"`;
            const headers: Record<string, string> = {
                'content-type': entry.contentType,
                'cache-control': verdict === 'fallback' ? 'public, max-age=0, must-revalidate' : cacheControl,
                'x-azeroth-image': verdict,
                etag
            };
            if (options.adapter !== undefined)
            {
                headers['vary'] = 'accept';
            }
            const conditional = context.request.headers.get('if-none-match');
            if (conditional !== null && matchesEtag(conditional, etag))
            {
                return new Response(null, { status: 304, headers });
            }
            return new Response(entry.data as BodyInit, { status: 200, headers });
        };

        const cached = await cache.get(key);
        if (cached !== undefined)
        {
            return respond(cached, 'hit');
        }
        if (!transformed)
        {
            const entry: ImageCacheEntry = { data: original.bytes, contentType: original.contentType };
            await cache.set(key, entry);
            return respond(entry, 'miss');
        }

        const adapter = options.adapter as ImageAdapter;
        let task = inflight.get(key);
        if (task === undefined)
        {
            task = adapter.transform(original.bytes, {
                ...(width !== undefined ? { width } : {}),
                quality,
                ...(format !== undefined ? { format } : {})
            }).finally(() => inflight.delete(key));
            inflight.set(key, task);
        }
        try
        {
            const entry = await task;
            await cache.set(key, entry);
            return respond(entry, 'miss');
        }
        catch (error)
        {
            onError(error, { path: source, phase: 'image' });
            return respond({ data: original.bytes, contentType: original.contentType }, 'fallback');
        }
    };
}
