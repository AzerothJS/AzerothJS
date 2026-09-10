// @vitest-environment node
//
// A static page whose url a FOREIGN guarded chain wins: mountPages cannot refuse it (the
// page's own chain is unguarded), so the runtime gate must answer every such url for THIS
// reader, and the build must not write a file for it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { forbidden, h, useLocale } from 'azerothjs';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html lang="en"><head><title>Shell</title></head><body><div id="root"></div></body></html>';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

const Page = (): HTMLElement =>
{
    const locale = useLocale();
    return h('main', {}, h('p', { id: 'seen' }, `page ${ locale() }`));
};

type Verdict = boolean | string;

/** A guarded `/docs/*rest` declared first wins every `/docs/...` url from the enumerated static page. */
function routes(verdict: Verdict): PageRoute[]
{
    return [
        {
            path: '/docs/*rest',
            component: Page,
            guard: () =>
            {
                if (verdict === 'throw')
                {
                    throw new Error('guard exploded');
                }
                return verdict === false ? forbidden() : verdict;
            }
        },
        { path: '/docs/:slug', component: Page, render: 'static', staticParams: () => Promise.resolve([{ slug: 'intro' }]) },
        { path: '/wild/*rest', component: Page, guard: () => forbidden() },
        { path: '/open', component: Page, render: 'static' }
    ];
}

function clientDir(withArtifacts = true): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-gate-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    if (withArtifacts)
    {
        mkdirSync(join(dir, 'docs', 'intro'), { recursive: true });
        writeFileSync(join(dir, 'docs', 'intro', 'index.html'), '<html><body>THE FILE</body></html>');
        mkdirSync(join(dir, 'docs', 'private'), { recursive: true });
        writeFileSync(join(dir, 'docs', 'private', 'index.html'), '<html><body>THE PRIVATE FILE</body></html>');
        mkdirSync(join(dir, 'open'));
        writeFileSync(join(dir, 'open', 'index.html'), '<html><body>OPEN FILE</body></html>');
    }
    dirs.push(dir);
    return dir;
}

function mount(verdict: Verdict, options: { renderer?: boolean; artifacts?: boolean; prefix?: boolean; negotiate?: boolean } = {}): App
{
    const table = routes(verdict);
    const app = new App();
    mountPages(app, {
        routes: table,
        clientDir: clientDir(options.artifacts ?? true),
        ...(options.renderer === true ? { renderer: createPageRenderer(() => Page(), table) } : {}),
        ...(options.prefix === true ? { locales: { supported: ['en', 'fa'], routing: 'prefix' } } : {}),
        ...(options.negotiate === true ? { locales: { supported: ['en', 'fa'] } } : {})
    });
    return app;
}

const get = (app: App, path: string): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html' } }));

describe('a static url a guarded chain wins, with a renderer', () =>
{
    it('takes the live render, stamped as this reader\'s own, never the file', async () =>
    {
        const app = mount(false, { renderer: true });
        const response = await get(app, '/docs/intro');
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(await response.text()).not.toContain('THE FILE');
        // Control: the unguarded static page still serves its file, cacheable.
        const open = await get(app, '/open');
        expect(await open.text()).toContain('OPEN FILE');
        expect(open.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    });

    it('a guard that passes still renders live for this reader', async () =>
    {
        const response = await get(mount(true, { renderer: true }), '/docs/intro');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(await response.text()).toContain('page en');
    });

    it('a guard that throws is the kernel\'s 500, with no file', async () =>
    {
        const response = await get(mount('throw', { renderer: true }), '/docs/intro');
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('THE FILE');
    });
});

describe('a static url a guarded chain wins, without a renderer: the walk decides', () =>
{
    it.each([
        ['a denial', false, 403, null],
        ['a redirect', '/login', 302, '/login'],
        ['an off-origin redirect', 'https://evil.example/x', 500, null]
    ] as const)('%s', async (_label, verdict, status, location) =>
    {
        const response = await get(mount(verdict), '/docs/intro');
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('location')).toBe(location);
        expect(await response.text()).not.toContain('THE FILE');
    });

    it('a pass serves the file, stamped as this reader\'s own', async () =>
    {
        const response = await get(mount(true), '/docs/intro');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(await response.text()).toContain('THE FILE');
    });

    it('a guard that throws is the kernel\'s 500, with no file', async () =>
    {
        const response = await get(mount('throw'), '/docs/intro');
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('THE FILE');
    });

    it('under prefix routing the encoded spelling reaches the same verdict as the plain one', async () =>
    {
        const app = mount(false, { prefix: true });
        for (const spelling of ['/fa/docs/intro', '/%66a/docs/intro'])
        {
            const response = await get(app, spelling);
            expect(response.status, spelling).toBe(403);
            expect(response.headers.get('cache-control'), spelling).toBe('private, no-store');
        }
    });

    it('an encoded separator in a param is one segment to the walk, as it is to the router', async () =>
    {
        // The walk sees the url the router matched, and the sibling file behind the re-joined
        // spelling is never served.
        const response = await get(mount(false), '/docs/%2Fprivate');
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.text()).not.toContain('THE PRIVATE FILE');
    });
});

describe('the bare shell for a guarded url is never heuristically cacheable', () =>
{
    it('the rendererless dynamic mount', async () =>
    {
        const table: PageRoute[] = [
            { path: '/docs/:slug', component: Page, guard: () => forbidden() },
            { path: '/docs/intro', component: Page, render: 'server' },
            { path: '/plain', component: Page, render: 'server' }
        ];
        const app = new App();
        mountPages(app, { routes: table, clientDir: clientDir(false) });
        const guarded = await get(app, '/docs/intro');
        expect(guarded.status).toBe(200);
        expect(guarded.headers.get('cache-control')).toBe('private, no-store');
        // Control: an unguarded shell carries no such stamp.
        expect((await get(app, '/plain')).headers.get('cache-control')).toBeNull();
    });

    it('the enumerated mount falling through to the shell with no file and no renderer', async () =>
    {
        const response = await get(mount(true, { artifacts: false }), '/docs/intro');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('a client-rendered page beside a renderer', async () =>
    {
        const table: PageRoute[] = [
            { path: '/docs/:slug', component: Page, guard: () => forbidden() },
            { path: '/docs/intro', component: Page, render: 'client' }
        ];
        const app = new App();
        mountPages(app, { routes: table, clientDir: clientDir(false), renderer: createPageRenderer(() => Page(), table) });
        const response = await get(app, '/docs/intro');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('the catch-all shell for a parent url the wildcard mount cannot dispatch', async () =>
    {
        const app = mount(false);
        const response = await get(app, '/wild');
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        // Control: an unrouted url is a plain 404 shell.
        expect((await get(app, '/nowhere')).headers.get('cache-control')).toBeNull();
    });
});

describe('the build refuses a file for a url a guarded chain wins', () =>
{
    it('names the url and the page', async () =>
    {
        const table = routes(true);
        await expect(prerender({ routes: table, clientDir: clientDir(false), renderer: createPageRenderer(() => Page(), table) }))
            .rejects.toThrow(/"\/docs\/intro" \(from "\/docs\/:slug"\) matches a guarded route chain/);
    });
});

describe('the rendererless gate under prefix routing', () =>
{
    it('answers a guard redirect in the request\'s url space, and the bare url is the locale redirect', async () =>
    {
        const app = mount('/login', { prefix: true });
        const prefixed = await get(app, '/fa/docs/intro');
        expect(prefixed.status).toBe(302);
        expect(prefixed.headers.get('location')).toBe('/fa/login');
        expect(prefixed.headers.get('cache-control')).toBe('private, no-store');
        const bare = await get(app, '/docs/intro');
        expect(bare.status).toBe(302);
        expect(bare.headers.get('location')).toBe('/en/docs/intro');
        expect(bare.headers.get('cache-control')).toBe('private, no-store');
        // The same table on a negotiate mount redirects bare.
        expect((await get(mount('/login', { negotiate: true }), '/docs/intro')).headers.get('location')).toBe('/login');
    });
});
