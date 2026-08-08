// @vitest-environment node
//
// ISR: a static page with `revalidate` serves from a page cache - fresh within the window,
// stale-while-revalidate past it, with exactly one background regeneration per key and the
// old copy surviving every failure. Prerendered files seed the cache through their mtime.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { FilePageCache, MemoryPageCache, mountPages, type PageCache, type PageEntry, type PageRoute } from '@azerothjs/kit';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-isr-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    return dir;
}

const component = (): HTMLElement => (undefined as unknown as HTMLElement);

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

interface Rig
{
    app: App;
    dir: string;
    calls: () => number;
    errors: Array<{ error: unknown; path: string; phase: string }>;
}

function build(routes: PageRoute[], renderer?: (url: string, shell: string) => Promise<PageResult>): Rig
{
    const dir = makeClientDir();
    dirs.push(dir);
    let count = 0;
    const errors: Rig['errors'] = [];
    const countingRenderer = (url: string, shell: string): Promise<PageResult> =>
    {
        count++;
        return renderer !== undefined
            ? renderer(url, shell)
            : Promise.resolve({ kind: 'html', status: 200, html: `<html><body>RENDER-${ count }:${ url }</body></html>` });
    };
    const app = new App();
    mountPages(app, {
        routes,
        clientDir: dir,
        renderer: countingRenderer,
        onError: (error, context) => void errors.push({ error, path: context.path, phase: context.phase })
    });
    return { app, dir, calls: () => count, errors };
}

const fetch = (app: App, path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));

async function settle(): Promise<void>
{
    await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ISR hot path', () =>
{
    it('miss renders once and caches; the second request is a hit without a render', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        const first = await fetch(rig.app, '/about');
        expect(first.status).toBe(200);
        expect(first.headers.get('x-azeroth-cache')).toBe('miss');
        expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
        expect(await first.text()).toContain('RENDER-1');

        const second = await fetch(rig.app, '/about');
        expect(second.headers.get('x-azeroth-cache')).toBe('hit');
        expect(second.headers.get('age')).not.toBeNull();
        expect(await second.text()).toContain('RENDER-1');
        expect(rig.calls()).toBe(1);
    });

    it('a stale entry serves the OLD html immediately and regenerates in the background', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 0.01 }]);
        await fetch(rig.app, '/about');
        await new Promise((resolve) => setTimeout(resolve, 30));

        const stale = await fetch(rig.app, '/about');
        expect(stale.headers.get('x-azeroth-cache')).toBe('stale');
        expect(await stale.text()).toContain('RENDER-1');

        await settle();
        const fresh = await fetch(rig.app, '/about');
        expect(await fresh.text()).toContain('RENDER-2');
    });

    it('ten parallel cold requests render exactly once', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(rig.app, '/about')));
        for (const response of responses)
        {
            expect(await response.text()).toContain('RENDER-1');
        }
        expect(rig.calls()).toBe(1);
    });

    it('a prerendered file seeds the cache: fresh mtime is a hit with zero renders', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        mkdirSync(join(rig.dir, 'about'));
        writeFileSync(join(rig.dir, 'about', 'index.html'), '<html><body>SEEDED</body></html>');

        const response = await fetch(rig.app, '/about');
        expect(await response.text()).toContain('SEEDED');
        expect(response.headers.get('x-azeroth-cache')).toBe('hit');
        expect(rig.calls()).toBe(0);
    });

    it('a seed past its window serves stale and regenerates', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        mkdirSync(join(rig.dir, 'about'));
        const file = join(rig.dir, 'about', 'index.html');
        writeFileSync(file, '<html><body>OLD-SEED</body></html>');
        const past = new Date(Date.now() - 300_000);
        utimesSync(file, past, past);

        const response = await fetch(rig.app, '/about');
        expect(await response.text()).toContain('OLD-SEED');
        expect(response.headers.get('x-azeroth-cache')).toBe('stale');

        await settle();
        const fresh = await fetch(rig.app, '/about');
        expect(await fresh.text()).toContain('RENDER-1');
        expect(rig.calls()).toBe(1);
    });

    it('a failed regeneration keeps the old entry and reports through onError', async () =>
    {
        let failing = false;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 0.01 }],
            (url, shell) => (failing
                ? Promise.reject(new Error('db down'))
                : Promise.resolve({ kind: 'html', status: 200, html: shell.replace('</body>', `FIRST:${ url }</body>`) })));
        await fetch(rig.app, '/about');
        failing = true;
        await new Promise((resolve) => setTimeout(resolve, 30));

        const stale = await fetch(rig.app, '/about');
        expect(await stale.text()).toContain('FIRST:/about');
        await settle();

        expect(rig.errors.length).toBeGreaterThan(0);
        expect(rig.errors[0]?.phase).toBe('revalidate');
        expect(rig.errors[0]?.path).toBe('/about');
        const after = await fetch(rig.app, '/about');
        expect(await after.text()).toContain('FIRST:/about');
    });

    it('a regeneration that redirects DELETES the entry so the live outcome surfaces', async () =>
    {
        let redirecting = false;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 0.01 }],
            (url, shell) => (redirecting
                ? Promise.resolve({ kind: 'redirect', to: '/login', replace: true })
                : Promise.resolve({ kind: 'html', status: 200, html: shell.replace('</body>', `OK:${ url }</body>`) })));
        await fetch(rig.app, '/about');
        redirecting = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await fetch(rig.app, '/about');
        await settle();

        const live = await fetch(rig.app, '/about');
        expect(live.status).toBe(302);
        expect(live.headers.get('location')).toBe('/login');
    });

    it('parameterized ISR keys per matched path', async () =>
    {
        const rig = build([{
            path: '/blog/:slug', component, render: 'static', revalidate: 60,
            staticParams: () => Promise.resolve([{ slug: 'a' }])
        }]);
        expect(await (await fetch(rig.app, '/blog/a')).text()).toContain(':/blog/a');
        expect(await (await fetch(rig.app, '/blog/b')).text()).toContain(':/blog/b');
        expect(rig.calls()).toBe(2);
        await fetch(rig.app, '/blog/a');
        expect(rig.calls()).toBe(2);
    });
});

describe('prerender and ISR', () =>
{
    it('prerender SKIPS a parameterized revalidate page with no staticParams - runtime ISR owns it', async () =>
    {
        const { prerender } = await import('@azerothjs/kit/prerender');
        const dir = makeClientDir();
        dirs.push(dir);
        const renderer = (url: string, shell: string): Promise<PageResult> =>
            Promise.resolve({ kind: 'html', status: 200, html: shell.replace('</body>', `${ url }</body>`) });
        const written = await prerender({
            routes: [
                { path: '/blog/:slug', component, render: 'static', revalidate: 60 },
                { path: '/about', component, render: 'static', revalidate: 60 }
            ],
            clientDir: dir,
            renderer
        });
        expect(written).toEqual(['/about']);
    });
});

describe('ISR boot validation', () =>
{
    it('revalidate without a renderer, on a non-static page, or non-positive, throws at mount', () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const renderer = (): Promise<PageResult> => Promise.resolve({ kind: 'html', status: 200, html: '' });

        expect(() => mountPages(new App(), {
            routes: [{ path: '/x', component, render: 'static', revalidate: 60 }], clientDir: dir
        })).toThrow(/renderer/);
        expect(() => mountPages(new App(), {
            routes: [{ path: '/x', component, render: 'server', revalidate: 60 }], clientDir: dir, renderer
        })).toThrow(/static/);
        expect(() => mountPages(new App(), {
            routes: [{ path: '/x', component, render: 'static', revalidate: 0 }], clientDir: dir, renderer
        })).toThrow(/positive/);
        expect(() => mountPages(new App(), {
            routes: [{ path: '/x', component, render: 'static', revalidate: Number.NaN }], clientDir: dir, renderer
        })).toThrow(/positive/);
    });
});

describe('page caches', () =>
{
    it('MemoryPageCache evicts insertion-first past maxEntries', async () =>
    {
        const cache = new MemoryPageCache({ maxEntries: 2 });
        const entry = (html: string): PageEntry => ({ html, status: 200, createdAt: Date.now() });
        await cache.set('/a', entry('A'));
        await cache.set('/b', entry('B'));
        await cache.set('/c', entry('C'));
        expect(await cache.get('/a')).toBeUndefined();
        expect((await cache.get('/b'))?.html).toBe('B');
        expect((await cache.get('/c'))?.html).toBe('C');
        await cache.delete('/b');
        expect(await cache.get('/b')).toBeUndefined();
    });

    it('FilePageCache round trips atomically, leaves no temp files, and treats corruption as a miss', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-isr-cache-'));
        dirs.push(dir);
        const cache = new FilePageCache(dir);
        await cache.set('/about', { html: '<html>X</html>', status: 200, createdAt: 123 });
        expect(await cache.get('/about')).toEqual({ html: '<html>X</html>', status: 200, createdAt: 123 });
        expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);

        for (const name of readdirSync(dir))
        {
            writeFileSync(join(dir, name), 'not json');
        }
        expect(await cache.get('/about')).toBeUndefined();

        await cache.set('/about', { html: '<html>Y</html>', status: 200, createdAt: 456 });
        await cache.delete('/about');
        expect(await cache.get('/about')).toBeUndefined();
    });
});

describe('a redeploy invalidates a persistent cache', () =>
{
    // THE BUG: a FilePageCache outlives the deploy that filled it. Its HTML names the previous
    // build's content-hashed assets, and the new build deleted those files - so the page answers
    // 200 with `x-azeroth-cache: hit` and renders blank, for as long as `revalidate` allows.
    // Nothing in the freshness check catches it, because the entry is not stale by age.
    // Reproduced against a real app: an asset URL from build 1 served after build 2 shipped.

    it('discards a cached copy older than the shell on disk', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-deploy-'));
        dirs.push(dir);
        const cacheDir = mkdtempSync(join(tmpdir(), 'az-deploy-cache-'));
        dirs.push(cacheDir);
        writeFileSync(join(dir, 'index.html'), SHELL);

        // A cache entry left by the PREVIOUS deploy, naming an asset that no longer exists.
        const cache = new FilePageCache(cacheDir);
        const stale: PageEntry = {
            html: '<html><body><script src="/assets/index-OLDHASH.js"></script></body></html>',
            status: 200,
            createdAt: Date.now() - 60_000
        };
        await cache.set('/about', stale);

        // The shell is newer than that entry: this is a fresh deploy.
        const app = new App();
        mountPages(app, {
            routes: [{ path: '/about', component, render: 'static', revalidate: 3600 }],
            clientDir: dir,
            cache,
            renderer: (url) => Promise.resolve({
                kind: 'html',
                status: 200,
                html: `<html><body><script src="/assets/index-NEWHASH.js"></script>${ url }</body></html>`
            })
        });

        const response = await fetch(app, '/about');
        const html = await response.text();
        expect(response.status).toBe(200);
        // The previous deploy's asset must be gone, and the current one served.
        expect(html).not.toContain('index-OLDHASH.js');
        expect(html).toContain('index-NEWHASH.js');
        // It is a genuine re-render, not a hit on the dead entry.
        expect(response.headers.get('x-azeroth-cache')).toBe('miss');
    });

    it('keeps a cached copy stamped with THIS build - a normal warm cache is untouched', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-deploy-keep-'));
        dirs.push(dir);
        const cacheDir = mkdtempSync(join(tmpdir(), 'az-deploy-keep-cache-'));
        dirs.push(cacheDir);
        writeFileSync(join(dir, 'index.html'), SHELL);

        const cache = new FilePageCache(cacheDir);
        await cache.set('/about', {
            html: '<html><body>CACHED-THIS-BUILD</body></html>',
            status: 200,
            createdAt: Date.now(),
            // How the id is derived: the shell's content hash, since the shell carries the
            // asset URLs and therefore changes exactly when they do.
            build: createHash('sha256').update(SHELL).digest('hex').slice(0, 16)
        });

        const app = new App();
        mountPages(app, {
            routes: [{ path: '/about', component, render: 'static', revalidate: 3600 }],
            clientDir: dir,
            cache,
            renderer: () => Promise.resolve({ kind: 'html', status: 200, html: '<html><body>RERENDERED</body></html>' })
        });

        const response = await fetch(app, '/about');
        expect(await response.text()).toContain('CACHED-THIS-BUILD');
        expect(response.headers.get('x-azeroth-cache')).toBe('hit');
    });

    it('the build stamp survives a FilePageCache round trip', async () =>
    {
        // Without this the stamp is dropped on read, every entry looks foreign, and the cache
        // silently degrades to no cache at all - correct output, none of the benefit.
        const cacheDir = mkdtempSync(join(tmpdir(), 'az-deploy-rt-'));
        dirs.push(cacheDir);
        const cache = new FilePageCache(cacheDir);
        await cache.set('/x', { html: '<p>x</p>', status: 200, createdAt: 1000, build: 'deadbeefdeadbeef' });
        expect((await cache.get('/x'))?.build).toBe('deadbeefdeadbeef');
    });

    it('an entry with NO build stamp is treated as foreign, then self-corrects', async () =>
    {
        // What a cache written by an older version looks like. It is discarded once and the
        // replacement carries a stamp, so the next request is a normal hit.
        const dir = mkdtempSync(join(tmpdir(), 'az-deploy-legacy-'));
        dirs.push(dir);
        const cacheDir = mkdtempSync(join(tmpdir(), 'az-deploy-legacy-cache-'));
        dirs.push(cacheDir);
        writeFileSync(join(dir, 'index.html'), SHELL);

        const cache = new FilePageCache(cacheDir);
        await cache.set('/about', { html: '<html><body>UNSTAMPED</body></html>', status: 200, createdAt: Date.now() });

        const app = new App();
        mountPages(app, {
            routes: [{ path: '/about', component, render: 'static', revalidate: 3600 }],
            clientDir: dir,
            cache,
            renderer: () => Promise.resolve({ kind: 'html', status: 200, html: '<html><body>FRESH</body></html>' })
        });

        const first = await fetch(app, '/about');
        expect(await first.text()).toContain('FRESH');
        expect(first.headers.get('x-azeroth-cache')).toBe('miss');

        const second = await fetch(app, '/about');
        expect(await second.text()).toContain('FRESH');
        expect(second.headers.get('x-azeroth-cache')).toBe('hit');
    });
});

describe('a broken page cache costs performance, never correctness', () =>
{
    // A cache is an OPTIMISATION. Before this, every cache write was unguarded, so a rejection
    // escaped the handler and the page answered 500 - with the HTML rendered perfectly and
    // `onError` silent. Real triggers: a read-only container filesystem (EROFS), a cache
    // directory that was never created, a full disk, a permissions error. Measured: a real
    // FilePageCache pointed at a missing directory made EVERY page 500.
    class SetRejects extends MemoryPageCache
    {
        public override set(): Promise<void>
        {
            return Promise.reject(Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }));
        }
    }

    class GetRejects extends MemoryPageCache
    {
        public override get(): Promise<PageEntry | undefined>
        {
            return Promise.reject(new Error('cache backend unreachable'));
        }
    }

    class DeleteRejects extends MemoryPageCache
    {
        public override delete(): Promise<void>
        {
            return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
        }
    }

    function withCache(cache: PageCache): Rig
    {
        const dir = makeClientDir();
        dirs.push(dir);
        let count = 0;
        const errors: Rig['errors'] = [];
        const app = new App();
        mountPages(app, {
            routes: [{ path: '/about', component, render: 'static', revalidate: 60 }],
            clientDir: dir,
            cache,
            renderer: (url) =>
            {
                count++;
                return Promise.resolve({ kind: 'html', status: 200, html: `<html><body>LIVE:${ url }</body></html>` });
            },
            onError: (error, context) => void errors.push({ error, path: context.path, phase: context.phase })
        });
        return { app, dir, calls: () => count, errors };
    }

    it('a failing cache WRITE still serves the rendered page, and reports', async () =>
    {
        const rig = withCache(new SetRejects());
        const response = await fetch(rig.app, '/about');
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('LIVE:/about');
        expect(rig.errors.length).toBeGreaterThan(0);
    });

    it('a failing cache READ degrades to a live render, and reports', async () =>
    {
        const rig = withCache(new GetRejects());
        const response = await fetch(rig.app, '/about');
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('LIVE:/about');
        expect(rig.errors.length).toBeGreaterThan(0);
    });

    it('a failing cache DELETE on the superseded-by-deploy path still serves', async () =>
    {
        // This path is reached by discarding an entry from another build - the very check added
        // for stale deploys, which introduced a second unguarded delete.
        const cache = new DeleteRejects();
        await MemoryPageCache.prototype.set.call(cache, '/about', {
            html: '<html><body>OLD-BUILD</body></html>',
            status: 200,
            createdAt: Date.now(),
            build: 'deadbeefdeadbeef'
        });
        const rig = withCache(cache);
        const response = await fetch(rig.app, '/about');
        expect(response.status).toBe(200);
        const body = await response.text();
        // The previous build's HTML must not survive, and the failed delete must not 500.
        expect(body).toContain('LIVE:/about');
        expect(body).not.toContain('OLD-BUILD');
        expect(rig.errors.length).toBeGreaterThan(0);
    });

    it('a real FilePageCache on a missing directory CREATES it and caches', async () =>
    {
        // This test used to assert the opposite - three renders and no caching - and called that
        // "the correct degradation". It was describing a defect: an absent directory is trivially
        // fixable, the class promises a cache "surviving restarts", and every write was failing
        // while requests still answered 200, so the loss was invisible outside the logs.
        const missing = join(mkdtempSync(join(tmpdir(), 'az-missing-')), 'nested', 'pages');
        dirs.push(missing);
        const rig = withCache(new FilePageCache(missing));
        for (const _attempt of [1, 2, 3])
        {
            const response = await fetch(rig.app, '/about');
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('LIVE:/about');
        }
        // Rendered once, then served from the cache the directory now has.
        expect(rig.calls()).toBe(1);
        expect(rig.errors).toEqual([]);
    });

    it('a FilePageCache that CANNOT be created still serves every page', async () =>
    {
        // The degradation the old test claimed to cover but never exercised: it only ever used an
        // absent directory. A path whose parent is a FILE cannot be created on any platform, so
        // this is the real read-only-volume shape - and a cache is an optimisation, so it must
        // cost pages nothing.
        const base = mkdtempSync(join(tmpdir(), 'az-unwritable-'));
        dirs.push(base);
        const blocker = join(base, 'not-a-dir');
        writeFileSync(blocker, 'this is a file, not a directory');

        const rig = withCache(new FilePageCache(join(blocker, 'pages')));
        for (const _attempt of [1, 2, 3])
        {
            const response = await fetch(rig.app, '/about');
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('LIVE:/about');
        }
        expect(rig.calls()).toBe(3);
        expect(rig.errors.length).toBeGreaterThan(0);
    });
});

describe('ISR and the query string', () =>
{
    // THE DEFECT: a non-ISR page receives `pathname + search` as its render URL, but an ISR page
    // receives the pathname alone - so `useSearch()` / `useQuery()` see {} on every ISR page, and
    // every distinct query collapses onto ONE cache entry. Adding `revalidate` to a route silently
    // changes what that route renders, with no error anywhere.
    //
    // The rig's default renderer echoes the URL it was handed, which is exactly the contract in
    // question, so these assertions read the real input rather than a proxy for it.

    it('hands the renderer the query string, exactly as a non-ISR route does', async () =>
    {
        const rig = build([{ path: '/search', component, render: 'static', revalidate: 60 }]);
        const body = await (await fetch(rig.app, '/search?q=azeroth')).text();
        expect(body).toContain('/search?q=azeroth');
    });

    it('CONTROL: a non-ISR route already receives the query', async () =>
    {
        // Without this the assertion above could be satisfied by a framework that never passes a
        // query anywhere, which would make the whole comparison vacuous.
        const rig = build([{ path: '/live', component, render: 'server' }]);
        const body = await (await fetch(rig.app, '/live?q=azeroth')).text();
        expect(body).toContain('/live?q=azeroth');
    });

    it('treats different queries as different pages', async () =>
    {
        const rig = build([{ path: '/search', component, render: 'static', revalidate: 60 }]);
        const a = await (await fetch(rig.app, '/search?q=postgres')).text();
        const b = await (await fetch(rig.app, '/search?q=security')).text();
        expect(a).toContain('q=postgres');
        expect(b).toContain('q=security');
        expect(a).not.toBe(b);
        // Two distinct pages means two renders, not one entry serving both.
        expect(rig.calls()).toBe(2);
    });

    it('serves a repeated query from cache rather than re-rendering', async () =>
    {
        const rig = build([{ path: '/search', component, render: 'static', revalidate: 60 }]);
        const first = await fetch(rig.app, '/search?q=same');
        const second = await fetch(rig.app, '/search?q=same');
        expect(first.headers.get('x-azeroth-cache')).toBe('miss');
        expect(second.headers.get('x-azeroth-cache')).toBe('hit');
        expect(rig.calls()).toBe(1);
    });

    it('normalises parameter order so one page is not cached twice', async () =>
    {
        // `?a=1&b=2` and `?b=2&a=1` are the same page. Without normalisation every permutation is
        // a separate cache entry, which is how a bounded cache gets filled by an attacker.
        const rig = build([{ path: '/search', component, render: 'static', revalidate: 60 }]);
        await fetch(rig.app, '/search?a=1&b=2');
        const second = await fetch(rig.app, '/search?b=2&a=1');
        expect(second.headers.get('x-azeroth-cache')).toBe('hit');
        expect(rig.calls()).toBe(1);
    });

    it('a bare request still seeds from the prerendered file', async () =>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        mkdirSync(join(rig.dir, 'about'));
        writeFileSync(join(rig.dir, 'about', 'index.html'), '<html><body>SEEDED</body></html>');

        const response = await fetch(rig.app, '/about');
        expect(await response.text()).toContain('SEEDED');
        expect(rig.calls()).toBe(0);
    });

    it('a QUERY request does NOT reuse the no-query prerendered file', async () =>
    {
        // The prerendered file is the rendering of `/about` with no query. Serving it for
        // `/about?utm_source=x` would hand back content rendered for a different URL - which is
        // this very defect, re-entering through the seed path. The query request renders live.
        //
        // The cost is real and worth stating: a tracking parameter now produces a render and a
        // cache entry on a page that has a perfectly good prerendered file. Correctness wins,
        // and the cache bound is what keeps that cost survivable.
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }]);
        mkdirSync(join(rig.dir, 'about'));
        writeFileSync(join(rig.dir, 'about', 'index.html'), '<html><body>SEEDED</body></html>');

        const response = await fetch(rig.app, '/about?utm_source=x');
        const body = await response.text();
        expect(body).not.toContain('SEEDED');
        expect(body).toContain('/about?utm_source=x');
        expect(rig.calls()).toBe(1);

        // And the bare path is still seeded, unaffected by the query request above.
        const bare = await fetch(rig.app, '/about');
        expect(await bare.text()).toContain('SEEDED');
    });
});

describe('FilePageCache is bounded', () =>
{
    // Making ISR query-aware widens an existing hole: the key space was already unbounded through
    // path parameters (`/article/:slug`), and now a visitor can also mint entries with arbitrary
    // query strings. On disk that is a fill vector, so the file cache gets the same cap the memory
    // cache has always had.
    it('evicts oldest-first once the cap is exceeded', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-bound-'));
        dirs.push(dir);
        const cache = new FilePageCache(dir, { maxEntries: 8 });

        for (let index = 0; index < 20; index++)
        {
            await cache.set(`/p/${ index }`, {
                html: `<p>${ index }</p>`, status: 200, createdAt: Date.now() + index, build: 'b'
            });
        }

        const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
        expect(files.length).toBeLessThanOrEqual(8);

        // The most recent writes survive; the earliest are gone.
        expect(await cache.get('/p/19')).not.toBeUndefined();
        expect(await cache.get('/p/0')).toBeUndefined();
    });

    it('is unbounded-by-default behaviour preserved for small caches', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-bound2-'));
        dirs.push(dir);
        const cache = new FilePageCache(dir, { maxEntries: 8 });
        await cache.set('/only', { html: '<p>x</p>', status: 200, createdAt: Date.now(), build: 'b' });
        expect((await cache.get('/only'))?.html).toBe('<p>x</p>');
    });
});

describe('ISR identity comes from the RAW path, not the decoded one', () =>
{
    // Found by an adversarial pass, not by this suite: `context.path` is percent-DECODED per
    // segment, so building the renderer URL and the cache key from it re-parses `%3F` as a query
    // delimiter and `%2F` as a segment separator. The same component served through `render:
    // 'server'` was always correct - only the ISR arm decoded first and parsed second.

    it('an encoded ? in a segment stays in the segment and does not become a query', async () =>
    {
        const rig = build([{ path: '/a/:slug', component, render: 'static', revalidate: 60 }]);

        const response = await fetch(rig.app, '/a/x%3Fq%3Da');
        const body = await response.text();

        // The renderer must receive the request as sent. Decoding first turns one page into
        // another: slug `x?q=a` with no query becomes slug `x` with `?q=a`.
        expect(body).toContain('/a/x%3Fq%3Da');
        expect(body).not.toContain('/a/x?q=a');
    });

    it('an encoded ? does NOT collide with the real query it decodes to', async () =>
    {
        const rig = build([{ path: '/a/:slug', component, render: 'static', revalidate: 60 }]);

        const encoded = await (await fetch(rig.app, '/a/x%3Fq%3Da')).text();
        const query = await (await fetch(rig.app, '/a/x?q=a')).text();

        // Two renders, two entries. Sharing one is how the second caller receives a page
        // rendered for a URL that was never theirs.
        expect(rig.calls()).toBe(2);
        expect(encoded).not.toBe(query);
    });

    it('an encoded / stays encoded, so the renderer sees one segment and not two', async () =>
    {
        // Asserting a 200 here would be vacuous: this rig's renderer is a stub that answers 200
        // for anything and never matches a route, so the real 404 (seen against a real app) cannot
        // reproduce in it. What IS observable here is the URL handed to the renderer, and that is
        // the thing the 404 was downstream of.
        const rig = build([{ path: '/a/:slug', component, render: 'static', revalidate: 60 }]);

        const body = await (await fetch(rig.app, '/a/z%2Fseg')).text();
        expect(body).toContain('/a/z%2Fseg');
        expect(body).not.toContain('/a/z/seg');
    });

    it('an encoded # in a segment is not truncated', async () =>
    {
        const rig = build([{ path: '/a/:slug', component, render: 'static', revalidate: 60 }]);

        const body = await (await fetch(rig.app, '/a/z%23frag')).text();
        expect(body).toContain('/a/z%23frag');
    });

    it('REGRESSION GUARD: a prerendered file still seeds, which needs the DECODED path', async () =>
    {
        // The seed lookup maps a URL path to a file the build wrote, and the build writes decoded
        // names. Moving the whole Target to the raw pathname would break seeding for any static
        // param needing encoding - so `path` must stay decoded while `url` and `key` do not.
        const rig = build([{ path: '/a/:slug', component, render: 'static', revalidate: 60 }]);
        mkdirSync(join(rig.dir, 'a', 'café'), { recursive: true });
        writeFileSync(join(rig.dir, 'a', 'café', 'index.html'), '<html><body>SEEDED-UNICODE</body></html>');

        const response = await fetch(rig.app, '/a/caf%C3%A9');
        expect(await response.text()).toContain('SEEDED-UNICODE');
        expect(rig.calls()).toBe(0);
    });
});

describe('FilePageCache creates the directory it was given', () =>
{
    // Every other FilePageCache test in this file starts with mkdtempSync, so the directory always
    // existed and this was invisible: without it, every write failed and the cache silently
    // degraded to no cache at all while still answering 200.

    it('round trips against a directory that does not exist yet', async () =>
    {
        const dir = join(mkdtempSync(join(tmpdir(), 'az-isr-mk-')), 'nested', 'cache');
        dirs.push(dir);

        const cache = new FilePageCache(dir);
        await cache.set('/p', { html: '<p>fresh</p>', status: 200, createdAt: Date.now(), build: 'b1' });
        expect((await cache.get('/p'))?.html).toBe('<p>fresh</p>');
    });

    it('recovers when the directory is removed while the server is running', async () =>
    {
        const dir = join(mkdtempSync(join(tmpdir(), 'az-isr-rm-')), 'cache');
        dirs.push(dir);

        const cache = new FilePageCache(dir);
        await cache.set('/p', { html: '<p>one</p>', status: 200, createdAt: Date.now(), build: 'b1' });
        rmSync(dir, { recursive: true, force: true });

        await cache.set('/p', { html: '<p>two</p>', status: 200, createdAt: Date.now(), build: 'b1' });
        expect((await cache.get('/p'))?.html).toBe('<p>two</p>');
    });
});
