/**
 * MODULE: kit/isr - incremental static regeneration over the page renderer
 *
 * A `render: 'static'` page with `revalidate` serves from a {@link PageCache}: fresh
 * within the window, stale-WHILE-revalidate past it - the old copy answers immediately
 * and exactly one background render replaces it. Every failure keeps the old copy; an
 * outcome that stopped being static content (a redirect, a veto, a 404) DELETES the
 * entry instead, so a guard is never masked by a year-old page. Prerendered files seed
 * the cache through their mtime, so a deploy's build output counts as a warm cache.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { html as htmlResponse } from '@azerothjs/http';
import type { App } from '@azerothjs/http';

import type { PageResult } from './ssr.ts';
import type { PageRenderer } from './ssr.ts';

/** One cached page: the finished HTML, its status, and when it was produced. */
export interface PageEntry
{
    html: string;
    status: number;

    /** Epoch millis the copy was produced (a prerendered seed's file mtime). */
    createdAt: number;

    /**
     * Which build produced this HTML - the client shell's content hash.
     *
     * A persistent cache outlives the deploy that filled it, and the HTML it holds names the
     * previous build's content-hashed assets, which the new build deleted. Age cannot detect
     * that (the entry is perfectly fresh), and comparing `createdAt` against the shell's mtime
     * cannot either: that pits an in-process clock against a filesystem timestamp and
     * misfires for any page cached moments after a deploy. The build's identity is exact and
     * clock-free. Absent on an entry written by an older version, which counts as a mismatch
     * once and then self-corrects.
     */
    build?: string;
}

/** Where ISR pages live. Implementations must treat any internal failure as a miss. */
export interface PageCache
{
    get(key: string): Promise<PageEntry | undefined>;
    set(key: string, entry: PageEntry): Promise<void>;
    delete(key: string): Promise<void>;
}

/** The in-process default: a bounded map evicting insertion-first. */
export class MemoryPageCache implements PageCache
{
    readonly #entries = new Map<string, PageEntry>();

    readonly #maxEntries: number;

    constructor(options: { maxEntries?: number } = {})
    {
        this.#maxEntries = options.maxEntries ?? 1000;
    }

    public get(key: string): Promise<PageEntry | undefined>
    {
        return Promise.resolve(this.#entries.get(key));
    }

    public set(key: string, entry: PageEntry): Promise<void>
    {
        this.#entries.delete(key);
        if (this.#entries.size >= this.#maxEntries)
        {
            const oldest = this.#entries.keys().next();
            if (oldest.done === false)
            {
                this.#entries.delete(oldest.value);
            }
        }
        this.#entries.set(key, entry);
        return Promise.resolve();
    }

    public delete(key: string): Promise<void>
    {
        this.#entries.delete(key);
        return Promise.resolve();
    }
}

/**
 * A filesystem cache surviving restarts. Writes are atomic - a temp file renamed over
 * the target - so a reader never sees a torn entry; a corrupt or foreign file is a miss.
 */
export class FilePageCache implements PageCache
{
    readonly #dir: string;

    readonly #maxEntries: number;

    /** Entries on disk, counted once then tracked, so the common write costs no readdir. */
    #count: number | null = null;

    constructor(dir: string, options: { maxEntries?: number } = {})
    {
        this.#dir = dir;
        this.#maxEntries = options.maxEntries ?? 1000;
        // An ABSENT directory is the common case and is trivially fixable, so fix it: without
        // this every write failed and the cache silently stored nothing while still answering
        // 200. A directory that cannot be created at all (a read-only volume) is NOT fatal - the
        // cache is an optimisation, and taking a server down at boot over one is worse than
        // serving every page uncached. `set` degrades and reports through `onError`.
        try
        {
            mkdirSync(dir, { recursive: true });
        }
        catch
        {
            // Left to `set`, which already treats a write failure as a miss.
        }
    }

    #fileFor(key: string): string
    {
        return join(this.#dir, `${ createHash('sha256').update(key).digest('hex') }.json`);
    }

    /**
     * Drops the oldest entries once the directory exceeds its cap.
     *
     * The key space is unbounded by construction - a parameterized route accepts any path segment,
     * and a query-aware key accepts any query - so without a cap any visitor can fill the disk.
     * Eviction is by mtime, oldest first, which approximates least-recently-written; a page that
     * keeps being regenerated keeps refreshing its mtime and survives.
     */
    async #evictIfNeeded(): Promise<void>
    {
        if (this.#count === null || this.#count <= this.#maxEntries)
        {
            return;
        }
        try
        {
            const names = (await readdir(this.#dir)).filter((name) => name.endsWith('.json'));
            const dated = await Promise.all(names.map(async (name) =>
            {
                const file = join(this.#dir, name);
                try
                {
                    return { file, at: (await stat(file)).mtimeMs };
                }
                catch
                {
                    return { file, at: 0 };
                }
            }));
            dated.sort((left, right) => left.at - right.at);
            const excess = dated.length - this.#maxEntries;
            for (const victim of dated.slice(0, Math.max(0, excess)))
            {
                await rm(victim.file, { force: true });
            }
            this.#count = Math.min(dated.length, this.#maxEntries);
        }
        catch
        {
            // A sweep that fails is not worth failing a request over; recount next time.
            this.#count = null;
        }
    }

    public async get(key: string): Promise<PageEntry | undefined>
    {
        try
        {
            const parsed = JSON.parse(await readFile(this.#fileFor(key), 'utf8')) as { key?: unknown; html?: unknown; status?: unknown; createdAt?: unknown; build?: unknown };
            // The stored key double-checks the hash: a mismatch is a miss, never a wrong page.
            if (parsed.key !== key || typeof parsed.html !== 'string' || typeof parsed.status !== 'number' || typeof parsed.createdAt !== 'number')
            {
                return undefined;
            }
            // `build` has to survive the round trip or every read looks like a foreign build and
            // the cache degrades to no cache at all.
            return {
                html: parsed.html,
                status: parsed.status,
                createdAt: parsed.createdAt,
                ...(typeof parsed.build === 'string' ? { build: parsed.build } : {})
            };
        }
        catch
        {
            return undefined;
        }
    }

    /** @internal The atomic write itself: temp file, then rename over the target. */
    async #write(file: string, key: string, entry: PageEntry): Promise<void>
    {
        const temp = `${ file }.${ randomUUID() }.tmp`;
        await writeFile(temp, JSON.stringify({ key, ...entry }), 'utf8');
        await rename(temp, file);
    }

    public async set(key: string, entry: PageEntry): Promise<void>
    {
        const file = this.#fileFor(key);
        const fresh = !existsSync(file);
        try
        {
            await this.#write(file, key, entry);
        }
        catch (error)
        {
            // The directory went away while the process was running (a cleaned volume, a tmpfs
            // reset). Rebuild it and write once more: the alternative is answering 200 forever
            // with a cache that silently stores nothing.
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            {
                throw error;
            }
            await mkdir(this.#dir, { recursive: true });
            this.#count = null;
            await this.#write(file, key, entry);
        }

        if (this.#count === null)
        {
            // First write of this process: learn the directory's size once. Only a filesystem
            // failure is tolerable here - swallowing everything once hid a missing import and
            // turned a crash into a cap that silently never applied.
            try
            {
                this.#count = (await readdir(this.#dir)).filter((name) => name.endsWith('.json')).length;
            }
            catch (error)
            {
                if (!(error instanceof Error) || !('code' in error))
                {
                    throw error;
                }
                this.#count = null;
            }
        }
        else if (fresh)
        {
            this.#count++;
        }
        await this.#evictIfNeeded();
    }

    public async delete(key: string): Promise<void>
    {
        await rm(this.#fileFor(key), { force: true });
        if (this.#count !== null)
        {
            this.#count = Math.max(0, this.#count - 1);
        }
    }
}

/** The kit's background-failure seam; `phase` names which machinery failed. */
export type KitErrorObserver = (error: unknown, context: { path: string; phase: 'revalidate' | 'image' }) => void;

/**
 * A finished BUFFERED {@link PageResult} as the response `mountPages` serves - the ONE
 * place the union maps to the wire, shared by per-request SSR and ISR's live outcomes.
 * The `stream` arm never reaches here (registerDynamic answers it directly); an unknown
 * kind (the union is documented open) serves the shell, never a crash.
 */
export function pageResponse(result: PageResult, shell: string): Response
{
    if (result.kind === 'redirect')
    {
        return new Response(null, { status: 302, headers: { location: result.to } });
    }
    // A vetoed route renders NOTHING: serve the plain shell (so the client can boot
    // and show its own 403 UI) with the guard's status - never the protected page.
    if (result.kind === 'blocked')
    {
        return htmlResponse(shell, { status: result.status });
    }
    if (result.kind === 'html')
    {
        return htmlResponse(result.html, { status: result.status });
    }
    return htmlResponse(shell);
}

/** Everything one ISR route registration needs, resolved by `mountPages`. */
export interface IsrRegistration
{
    app: App;
    path: string;

    /** Seconds a copy stays fresh. */
    revalidate: number;
    cache: PageCache;
    renderer: PageRenderer;
    shell: Promise<string>;

    /** Resolves a cache key to its prerendered seed file, null when outside the dist. */
    seedFile: (key: string) => string | null;
    onError: KitErrorObserver;

    /**
     * Identity of the build being served - the client shell's content hash, computed once at
     * mount. A cached copy stamped with a different one came from a previous deploy and names
     * assets that no longer exist, so it is discarded on read.
     */
    buildId: Promise<string>;
}

/** @internal What one cold-miss production yields: a cacheable entry or a live outcome. */
interface Produced
{
    entry?: PageEntry;
    live?: PageResult;
    seeded?: boolean;
}

/**
 * The cache identity of one request: its pathname plus its query in a canonical order.
 *
 * Sorting matters for more than tidiness. `?a=1&b=2` and `?b=2&a=1` are the same page, and
 * without normalisation every permutation of n parameters is a separate entry - n! ways for a
 * visitor to fill a bounded cache with copies of one page. Sorting collapses them to one.
 *
 * Repeated keys keep their order relative to each other (`?a=1&a=2` is not `?a=2&a=1`), because
 * a repeated parameter is an ordered list to most readers.
 *
 * @internal
 */
export function cacheKeyFor(pathname: string, search: string): string
{
    if (search === '' || search === '?')
    {
        return pathname;
    }
    const params = new URLSearchParams(search);
    const sorted = [...params.keys()]
        .filter((name, index, all) => all.indexOf(name) === index)
        .sort()
        .flatMap((name) => params.getAll(name).map((value) => [name, value] as const));
    const canonical = new URLSearchParams(sorted.map(([name, value]) => [name, value])).toString();
    return canonical === '' ? pathname : `${ pathname }?${ canonical }`;
}

/** Registers one ISR page (parameterized or not) on the app. */
export function registerIsr(registration: IsrRegistration): void
{
    const { app, path, revalidate, cache, renderer, shell, seedFile, onError, buildId } = registration;
    const inflight = new Map<string, Promise<Produced>>();
    const regenerating = new Set<string>();

    /**
     * Whether a cached copy came from a different build than the one being served. Such an entry
     * is perfectly fresh by age and completely broken in fact: its HTML names the previous
     * build's content-hashed assets, which this build deleted.
     */
    const supersededByDeploy = async (entry: PageEntry): Promise<boolean> => entry.build !== await buildId;

    // A CACHE IS AN OPTIMISATION. It must never be able to fail a request that already rendered.
    //
    // The PageCache doc asks implementations to treat internal failures as a miss, but the caller
    // cannot rely on that and the framework's own FilePageCache did not honour it for writes: a
    // cache directory that does not exist, a read-only container filesystem (EROFS), a full disk
    // or a permissions error made `set`/`delete` reject, the rejection escaped the handler, and
    // EVERY page answered 500 - with the page itself rendered perfectly and `onError` silent.
    // These three wrappers degrade to "no cache" and report, so the worst a broken cache can do
    // is cost performance.
    const readCache = async (key: string): Promise<PageEntry | undefined> =>
    {
        try
        {
            return await cache.get(key);
        }
        catch (error)
        {
            onError(error, { path: key, phase: 'revalidate' });
            return undefined;
        }
    };
    const writeCache = async (key: string, entry: PageEntry): Promise<void> =>
    {
        try
        {
            await cache.set(key, entry);
        }
        catch (error)
        {
            onError(error, { path: key, phase: 'revalidate' });
        }
    };
    const dropCache = async (key: string): Promise<void> =>
    {
        try
        {
            await cache.delete(key);
        }
        catch (error)
        {
            onError(error, { path: key, phase: 'revalidate' });
        }
    };

    /**
     * One request's three identities, which are NOT the same string:
     *
     * - `path`  the pathname alone. What a prerendered file is named after on disk, and what an
     *           error report should say.
     * - `url`   pathname + search. What the renderer needs, because the query is how the page
     *           reads `useSearch()` / `useQuery()` - and what a non-ISR route has always received.
     * - `key`   pathname + NORMALISED search. What the cache is keyed on.
     *
     * Conflating them is the bug this replaces: `key` was `context.path` and was also handed to
     * the renderer, so every ISR page rendered as though it had no query and every distinct query
     * collapsed onto one entry.
     */
    interface Target
    {
        /**
         * The DECODED pathname, used ONLY to find a prerendered file and to name the page in an
         * error report. The build writes decoded filenames (`prerenderFileFor` over the static
         * path list), so a `staticParams` value of `café` lands at `a/café/index.html` while the
         * request arrives as `/a/caf%C3%A9`. Seeding needs the decoded spelling; nothing else does.
         */
        path: string;

        /** The RAW pathname plus the raw search - the request exactly as sent. */
        url: string;

        /** The RAW pathname plus the normalised search: this page's cache identity. */
        key: string;

        /** No query at all, so a prerendered file is a legitimate representation of it. */
        seedable: boolean;
    }

    /**
     * Builds the identities from one request.
     *
     * `url` and `key` come from the RAW pathname, never `context.path`. A decoded path re-parsed
     * as a URL is a different URL: `%3F` becomes a query delimiter, `%2F` a segment separator, and
     * `%23` a fragment. That turns one page into another and lets two distinct requests derive one
     * cache key. `index.ts` has always passed the raw pathname on the non-ISR paths; this matches.
     */
    const targetOf = (context: { path: string; url: URL }): Target =>
    {
        const search = context.url.search;
        return {
            path: context.path,
            url: context.url.pathname + search,
            key: cacheKeyFor(context.url.pathname, search),
            seedable: search === '' || search === '?'
        };
    };

    async function produce(target: Target): Promise<Produced>
    {
        // Seeding is keyed on the PATHNAME: a prerendered file has no query component, so a seed
        // is only ever the no-query representation of the page.
        const seed = target.seedable ? seedFile(target.path) : null;
        if (seed !== null)
        {
            try
            {
                const [html, info] = await Promise.all([readFile(seed, 'utf8'), stat(seed)]);
                const entry: PageEntry = { html, status: 200, createdAt: info.mtimeMs, build: await buildId };
                await writeCache(target.key, entry);
                return { entry, seeded: true };
            }
            catch
            {
                // No seed on disk - render live.
            }
        }
        const result = await renderer(target.url, await shell);
        if (result.kind === 'html' && result.status === 200)
        {
            const entry: PageEntry = { html: result.html, status: 200, createdAt: Date.now(), build: await buildId };
            await writeCache(target.key, entry);
            return { entry };
        }
        return { live: result };
    }

    function produceOnce(target: Target): Promise<Produced>
    {
        const existing = inflight.get(target.key);
        if (existing !== undefined)
        {
            return existing;
        }
        const task = produce(target).finally(() => inflight.delete(target.key));
        inflight.set(target.key, task);
        return task;
    }

    function regenerate(target: Target): void
    {
        if (regenerating.has(target.key))
        {
            return;
        }
        regenerating.add(target.key);
        void (async (): Promise<void> =>
        {
            try
            {
                const result = await renderer(target.url, await shell);
                if (result.kind === 'html' && result.status === 200)
                {
                    await writeCache(target.key, { html: result.html, status: 200, createdAt: Date.now(), build: await buildId });
                    return;
                }
                // The page stopped being static content: keeping the stale copy would mask
                // a guard (or a deletion) indefinitely. Drop it; the next request goes live.
                await dropCache(target.key);
                onError(new Error(`ISR regeneration of "${ target.url }" produced ${ result.kind }`
                    + `${ result.kind === 'html' ? ` status ${ result.status }` : '' } - entry dropped.`),
                { path: target.path, phase: 'revalidate' });
            }
            catch (error)
            {
                onError(error, { path: target.path, phase: 'revalidate' });
            }
            finally
            {
                regenerating.delete(target.key);
            }
        })();
    }

    function respond(entry: PageEntry, verdict: 'hit' | 'stale' | 'miss', age: number): Response
    {
        return htmlResponse(entry.html, {
            status: entry.status,
            headers: {
                'cache-control': 'public, max-age=0, must-revalidate',
                age: String(Math.max(0, Math.floor(age))),
                'x-azeroth-cache': verdict
            }
        });
    }

    app.get(path, async (context) =>
    {
        const target = targetOf(context);
        let entry = await readCache(target.key);
        if (entry !== undefined && await supersededByDeploy(entry))
        {
            // Produced by an earlier deploy, so its asset URLs are dead. Drop it and produce
            // fresh - the prerendered file this build wrote is right there to seed from.
            await dropCache(target.key);
            entry = undefined;
        }
        let verdict: 'hit' | 'miss' = 'hit';
        if (entry === undefined)
        {
            const produced = await produceOnce(target);
            if (produced.entry === undefined)
            {
                return pageResponse(produced.live as PageResult, await shell);
            }
            entry = produced.entry;
            // A prerendered seed IS cache content already on disk; only a live render is a miss.
            verdict = produced.seeded === true ? 'hit' : 'miss';
        }
        const age = (Date.now() - entry.createdAt) / 1000;
        if (age <= revalidate)
        {
            return respond(entry, verdict, age);
        }
        regenerate(target);
        return respond(entry, 'stale', age);
    });
}
