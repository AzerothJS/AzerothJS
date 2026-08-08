// @vitest-environment node
//
// SSG over parameterized routes: staticParams enumerates the param sets a static route
// prerenders, prerender writes one file per set, and mountPages serves those files
// static-first with unlisted params falling through to the live renderer. Invalid params
// are BUILD errors - a bad slug must never become a path segment silently.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App, json } from '@azerothjs/http';
import { flattenPages, mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-ssg-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    return dir;
}

const component = (): HTMLElement => (undefined as unknown as HTMLElement);

const fakeRenderer = (url: string, shell: string): Promise<PageResult> =>
{
    if (url.startsWith('/blog/redirected'))
    {
        return Promise.resolve({ kind: 'redirect', to: '/login', replace: true });
    }
    return Promise.resolve({ kind: 'html', status: 200, html: shell.replace('<div id="root"></div>', `<div id="root">SSR:${ url }</div>`) });
};

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('flattenPages carries the SSG fields', () =>
{
    it('staticParams stays on its own leaf; revalidate inherits downward like render', () =>
    {
        const list = (): Promise<Array<Record<string, string>>> => Promise.resolve([{ slug: 'a' }]);
        const routes: PageRoute[] = [
            { path: '/blog/:slug', component, render: 'static', staticParams: list },
            {
                path: '/docs', component, render: 'static', revalidate: 60,
                children: [{ path: 'intro', component }, { path: 'live', component, revalidate: 5 }]
            }
        ];
        const flat = flattenPages(routes);
        expect(flat).toEqual([
            { path: '/blog/:slug', render: 'static', staticParams: list },
            { path: '/docs/intro', render: 'static', revalidate: 60 },
            { path: '/docs/live', render: 'static', revalidate: 5 }
        ]);
    });
});

describe('prerender enumerates staticParams', () =>
{
    it('writes one file per param set and reports the resolved paths', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const routes: PageRoute[] = [{
            path: '/blog/:slug', component, render: 'static',
            staticParams: () => Promise.resolve([{ slug: 'hello' }, { slug: 'world' }])
        }];
        const written = await prerender({ routes, clientDir: dir, renderer: fakeRenderer });
        expect(written).toEqual(['/blog/hello', '/blog/world']);
        expect(readFileSync(join(dir, 'blog', 'hello', 'index.html'), 'utf8')).toContain('SSR:/blog/hello');
        expect(readFileSync(join(dir, 'blog', 'world', 'index.html'), 'utf8')).toContain('SSR:/blog/world');
        expect(readFileSync(join(dir, 'shell.html'), 'utf8')).toContain('<div id="root"></div>');
    });

    it('duplicate param sets write once, first wins, silently', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const written = await prerender({
            routes: [{
                path: '/blog/:slug', component, render: 'static',
                staticParams: () => Promise.resolve([{ slug: 'a' }, { slug: 'a' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        });
        expect(written).toEqual(['/blog/a']);
    });

    it('multi-param patterns substitute every segment', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const written = await prerender({
            routes: [{
                path: '/docs/:section/:page', component, render: 'static',
                staticParams: () => Promise.resolve([{ section: 'guide', page: 'intro' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        });
        expect(written).toEqual(['/docs/guide/intro']);
        expect(existsSync(join(dir, 'docs', 'guide', 'intro', 'index.html'))).toBe(true);
    });

    it('a missing, empty, slash-carrying, or dot-segment param value is a BUILD error naming the route and param', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const attempt = (value: Record<string, string>): Promise<string[]> => prerender({
            routes: [{
                path: '/blog/:slug', component, render: 'static',
                staticParams: () => Promise.resolve([value])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        });
        await expect(attempt({})).rejects.toThrow(/\/blog\/:slug.*slug/s);
        await expect(attempt({ slug: '' })).rejects.toThrow(/slug/);
        await expect(attempt({ slug: 'x/y' })).rejects.toThrow(/slug/);
        await expect(attempt({ slug: '..' })).rejects.toThrow(/slug/);
        expect(existsSync(join(dir, '..', 'index.html'))).toBe(false);
    });

    it('a redirecting enumerated path is a BUILD error naming the resolved path', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{
                path: '/blog/:slug', component, render: 'static',
                staticParams: () => Promise.resolve([{ slug: 'redirected' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/\/blog\/redirected/);
    });

    it('parameterized static WITHOUT staticParams still hard errors (regression pin)', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{ path: '/users/:id', component, render: 'static' }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/parameters/);
    });

    it('a wildcard static route cannot enumerate, staticParams or not', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{
                path: '/files/*rest', component, render: 'static',
                staticParams: () => Promise.resolve([{ rest: 'a' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/wildcard/);
    });

    it('staticParams on a non-parameterized static route is a contradiction and a BUILD error', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{
                path: '/about', component, render: 'static',
                staticParams: () => Promise.resolve([{ x: 'y' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/staticParams/);
    });
});

describe('mountPages serves enumerated static routes file-first', () =>
{
    function build(routes: PageRoute[], withRenderer: boolean): { app: App; dir: string }
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const app = new App();
        app.get('/api/ping', () => json({ ok: true }));
        mountPages(app, { routes, clientDir: dir, ...(withRenderer ? { renderer: fakeRenderer } : {}) });
        return { app, dir };
    }
    const fetch = (app: App, path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));
    const blogRoutes: PageRoute[] = [{
        path: '/blog/:slug', component, render: 'static',
        staticParams: () => Promise.resolve([{ slug: 'hello' }])
    }];

    it('a prerendered param serves the written file bytes with an etag', async () =>
    {
        const { app, dir } = build(blogRoutes, true);
        mkdirSync(join(dir, 'blog', 'hello'), { recursive: true });
        writeFileSync(join(dir, 'blog', 'hello', 'index.html'), '<html><body>PRERENDERED-HELLO</body></html>');
        const response = await fetch(app, '/blog/hello');
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('PRERENDERED-HELLO');
        expect(response.headers.get('etag')).not.toBeNull();
    });

    it('an unlisted param falls through to per-request SSR', async () =>
    {
        const { app } = build(blogRoutes, true);
        const html = await (await fetch(app, '/blog/surprise')).text();
        expect(html).toContain('SSR:/blog/surprise');
    });

    it('an unlisted param that redirects gets a REAL 302', async () =>
    {
        const { app } = build(blogRoutes, true);
        const response = await fetch(app, '/blog/redirected');
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/login');
    });

    it('without a renderer the fallthrough serves the shell', async () =>
    {
        const { app } = build(blogRoutes, false);
        const html = await (await fetch(app, '/blog/anything')).text();
        expect(html).toContain('<div id="root"></div>');
    });

    it('api priority and asset fallback survive a parameterized static mount', async () =>
    {
        const { app } = build(blogRoutes, true);
        expect(((await (await fetch(app, '/api/ping')).json()) as { ok: boolean }).ok).toBe(true);
        expect((await fetch(app, '/assets/app.js')).status).toBe(200);
        expect((await fetch(app, '/assets/nope.js')).status).toBe(404);
    });
});

describe('a failed build leaves no half-generated page set', () =>
{
    // The exit code is the primary contract and it works - but a deploy joined with `;`, or a
    // Dockerfile whose next RUN copies dist/, ships whatever landed on disk. For a static-only
    // target (dist/ rsynced to a CDN, no renderer to fall through to) a half-generated set is a
    // live site missing most of its pages, and it LOOKS like a successful build. Observed for
    // real: a 250-page corpus with one bad param left 5 pages on disk after the failure.
    it('removes the pages it wrote when a later param is invalid', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{
                path: '/blog/:slug', component, render: 'static',
                // Three good slugs, then one that cannot become a path segment.
                staticParams: () => Promise.resolve([{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, { slug: '../escape' }])
            }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/slug/);

        // The three that succeeded before the throw must be gone.
        for (const slug of ['a', 'b', 'c'])
        {
            expect(existsSync(join(dir, 'blog', slug, 'index.html'))).toBe(false);
        }
        // The client build's own output is untouched - only the prerender's pages roll back.
        expect(existsSync(join(dir, 'index.html'))).toBe(true);
        expect(existsSync(join(dir, 'shell.html'))).toBe(true);
    });

    it('a rerun after the failure regenerates the full set', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const routes = (slugs: string[]): PageRoute[] => [{
            path: '/blog/:slug', component, render: 'static',
            staticParams: () => Promise.resolve(slugs.map((slug) => ({ slug })))
        }];

        await expect(prerender({ routes: routes(['a', 'b', '../escape']), clientDir: dir, renderer: fakeRenderer }))
            .rejects.toThrow(/slug/);
        expect(existsSync(join(dir, 'blog', 'a', 'index.html'))).toBe(false);

        const written = await prerender({ routes: routes(['a', 'b']), clientDir: dir, renderer: fakeRenderer });
        expect(written).toEqual(['/blog/a', '/blog/b']);
        expect(existsSync(join(dir, 'blog', 'a', 'index.html'))).toBe(true);
        expect(existsSync(join(dir, 'blog', 'b', 'index.html'))).toBe(true);
    });
});

describe('rollback restores overwritten files, not just created ones', () =>
{
    // The root page writes to dist/index.html, which vite already produced. A rollback that
    // only DELETED would strip the client shell and leave the site with no homepage - worse
    // than the partial build it was fixing.
    it('a failed build leaves vite\'s index.html byte-identical', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const before = readFileSync(join(dir, 'index.html'), 'utf8');

        await expect(prerender({
            routes: [
                { path: '/', component, render: 'static' },
                {
                    path: '/blog/:slug', component, render: 'static',
                    staticParams: () => Promise.resolve([{ slug: 'ok' }, { slug: '../escape' }])
                }
            ],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/slug/);

        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'blog', 'ok', 'index.html'))).toBe(false);
    });
});
